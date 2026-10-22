import { createHash } from "node:crypto";
import { dateOnly } from "./core.mjs";

const iso =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !iso.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Нужна дата ISO 8601 с часовым поясом.");
  dateOnly(value.slice(0, 10));
  return value;
}
function number(value) {
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error("Некорректное значение активности.");
  const normalized =
    typeof value === "string"
      ? value
          .trim()
          .replace(/[\s\u00a0\u202f]/g, "")
          .replace(",", ".")
      : value;
  if (normalized === "" || !Number.isFinite(Number(normalized)))
    throw new Error("Некорректное значение активности.");
  return Number(normalized);
}

// Health samples from different sources must never be added together.
export function parseActivityImport(
  text,
  { source = process.env.RUNLOG_HEALTH_SOURCE, now = new Date() } = {},
) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 8 * 1024 * 1024)
    throw new Error("Файл активности должен быть не больше 8 МБ.");
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(
      "Файл синхронизации ещё не записан полностью или содержит неверный JSON.",
    );
  }
  if (
    input?.format !== "runlog-health-v1" ||
    !Array.isArray(input.steps) ||
    !Array.isArray(input.distance)
  )
    throw new Error(
      "Нужен файл runlog-health-v1 из команды RUNLOG Health Sync.",
    );
  const generatedAt = timestamp(input.generatedAt);
  if (Date.parse(generatedAt) > now.getTime() + 5 * 60_000)
    throw new Error(
      "Время экспорта находится в будущем. Проверь часы на телефоне.",
    );
  const raw = [
    ...input.steps.map((s) => ({ ...s, kind: "steps" })),
    ...input.distance.map((s) => ({ ...s, kind: "distance" })),
  ];
  if (raw.length > 20000)
    throw new Error(
      "Слишком много образцов активности. Экспортируй последние 7 дней.",
    );
  const warnings = [],
    samples = [],
    seen = new Map();
  for (const s of raw) {
    const start = timestamp(s.start),
      end = timestamp(s.end);
    if (
      Date.parse(end) < Date.parse(start) ||
      Date.parse(end) > Date.parse(generatedAt) + 5 * 60_000
    )
      throw new Error("Некорректный интервал образца активности.");
    const sourceName = String(s.source || "").trim();
    if (!sourceName || sourceName.length > 200)
      throw new Error("В образце не указан источник Health.");
    let value = number(s.value);
    const unit = String(s.unit || "")
      .trim()
      .toLowerCase();
    if (s.kind === "steps") {
      if (
        ![
          "count",
          "steps",
          "step",
          "шаг",
          "шаги",
          "шагов",
          "шт.",
          "шт",
        ].includes(unit)
      )
        throw new Error(`Неизвестная единица шагов: ${unit}.`);
      if (value < 0 || value > 200000)
        throw new Error("Количество шагов вне допустимого диапазона.");
    } else {
      const factors = {
        km: 1,
        км: 1,
        m: 0.001,
        м: 0.001,
        mi: 1.609344,
        mile: 1.609344,
        miles: 1.609344,
        мили: 1.609344,
        миль: 1.609344,
      };
      if (!Object.hasOwn(factors, unit))
        throw new Error(`Неизвестная единица дистанции: ${unit}.`);
      value *= factors[unit];
      if (value < 0 || value > 500)
        throw new Error("Дистанция вне допустимого диапазона.");
    }
    if (start.slice(0, 10) !== end.slice(0, 10)) {
      warnings.push(
        "Образцы через полночь исключены: точное распределение между днями неизвестно.",
      );
      continue;
    }
    const key = JSON.stringify([s.kind, sourceName, start, end]);
    if (seen.has(key)) {
      if (seen.get(key) !== value)
        throw new Error("Обнаружены конфликтующие образцы за один интервал.");
      continue;
    }
    seen.set(key, value);
    samples.push({ kind: s.kind, source: sourceName, start, end, value });
  }
  const availableSources = [...new Set(samples.map((s) => s.source))].sort();
  if (!samples.length)
    throw new Error(
      "Нет доступных образцов. Проверь разрешение на чтение шагов и дистанции в «Здоровье». Пустой экспорт не считается нулевой активностью.",
    );
  const phones = availableSources.filter((s) => /iphone/i.test(s));
  const selected =
    source ||
    (phones.length === 1
      ? phones[0]
      : availableSources.length === 1
        ? availableSources[0]
        : null);
  if (!selected || !availableSources.includes(selected))
    throw new Error(
      `Выбери один источник в RUNLOG_HEALTH_SOURCE: ${availableSources.join("; ")}.`,
    );
  const days = new Map();
  for (const s of samples.filter((s) => s.source === selected)) {
    const date = s.start.slice(0, 10);
    const day = days.get(date) || {
      date,
      steps: null,
      distanceKm: null,
      sampleCount: 0,
      source: selected,
      generatedAt,
    };
    const field = s.kind === "steps" ? "steps" : "distanceKm";
    day[field] = (day[field] ?? 0) + s.value;
    day.sampleCount++;
    days.set(date, day);
  }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of rows) {
    if (row.steps > 200000 || row.distanceKm > 500)
      throw new Error("Сумма за день вне допустимого диапазона.");
    // The first date is a rolling-window boundary; today is still in progress.
    row.partial =
      row.date === rows[0].date || row.date === generatedAt.slice(0, 10);
    if (row.distanceKm !== null)
      row.distanceKm = Math.round(row.distanceKm * 1e6) / 1e6;
  }
  return {
    rows,
    generatedAt,
    source: selected,
    availableSources,
    warnings: [...new Set(warnings)],
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

export function activityReport(rows, { today, days = 7 } = {}) {
  if (![7, 30, 90].includes(days))
    throw new Error("Выбери период 7, 30 или 90 дней.");
  dateOnly(today);
  const start = new Date(`${today}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const selected = rows.filter(
    (r) => r.date >= start.toISOString().slice(0, 10) && r.date <= today,
  );
  const stepDays = selected.filter((r) => r.steps != null);
  const totalSteps = stepDays.reduce((sum, r) => sum + r.steps, 0);
  const latest = selected.reduce(
    (max, r) =>
      !max || Date.parse(r.generatedAt) > Date.parse(max) ? r.generatedAt : max,
    "",
  );
  return {
    verified: true,
    sources: selected,
    sourceCount: selected.length,
    metrics: {
      totalSteps,
      recordedDays: stepDays.length,
      requestedDays: days,
      latest: latest || null,
    },
    reply: selected.length
      ? `Активность за ${days} дней: ${Math.round(totalSteps).toLocaleString("ru-RU")} шагов по ${stepDays.length} дням с данными.\nПоследний экспорт: ${latest}.\nСегодняшний день и граница экспорта могут быть неполными. Дни без данных не считаются нулевыми. Это повседневная активность, а не дистанция пробежек.`
      : "Данных активности за этот период нет. Запусти RUNLOG Health Sync на iPhone и дождись синхронизации iCloud.",
  };
}
