import { summarize, labels, dateOnly } from "./core.mjs";

const decimal = (n) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
export function formatTime(value) {
  if (value == null) return "—";
  const n = Math.round(value);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function source(w) {
  return {
    id: w.id ?? null,
    date: w.date,
    sport: w.sport,
    distanceKm: w.distanceKm,
    durationSeconds: w.durationSeconds,
    avgHR: w.avgHR,
  };
}
export function selectPeriod(workouts, { today, days = null } = {}) {
  if (today) dateOnly(today);
  if (days !== null && ![7, 30, 90].includes(days))
    throw new Error("Поддерживаются периоды 7, 30, 90 дней или вся история.");
  if (!days) return [...workouts];
  if (!today) throw new Error("Для периода нужна текущая дата.");
  const first = new Date(`${today}T12:00:00Z`);
  first.setUTCDate(first.getUTCDate() - days + 1);
  const start = first.toISOString().slice(0, 10);
  return workouts.filter((w) => w.date >= start && w.date <= today);
}
export function buildReport(workouts, options = {}) {
  const records = selectPeriod(workouts, options).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const summary = summarize(records);
  const scope = options.days ? `за ${options.days} дней` : "за всё время";
  const title = `Сводка ${scope}`;
  if (!records.length)
    return {
      title,
      summary,
      sources: [],
      sourceCount: 0,
      reply: `${title}\nНет сохранённых тренировок за этот период.`,
      verified: true,
    };
  const range = `${records[0].date} — ${records.at(-1).date}`;
  const reply = [
    title,
    `Записей: ${records.length}. Период: ${range}.`,
    `Пробежек: ${summary.runs}. Дистанция бега: ${decimal(summary.totalKm)} км.`,
    summary.averagePaceSeconds == null
      ? "Средний темп: недостаточно данных о времени и дистанции."
      : `Средний темп бега: ${formatTime(summary.averagePaceSeconds)} /км.`,
    `Источник: ${records.length} подтверждённых записей дневника.`,
  ].join("\n");
  return {
    title,
    summary,
    sources: records.map(source),
    sourceCount: records.length,
    reply,
    verified: true,
  };
}
export function buildHistory(workouts) {
  const records = [...workouts]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);
  return {
    title: "Последние тренировки",
    sources: records.map(source),
    sourceCount: records.length,
    verified: true,
    reply: records.length
      ? [
          "Последние тренировки",
          ...records.map(
            (w) =>
              `${w.date} · ${labels[w.sport] || "Тренировка"} · ${w.distanceKm ? `${decimal(w.distanceKm)} км` : "без дистанции"} · ${formatTime(w.durationSeconds)}${w.avgHR ? ` · пульс ${w.avgHR}` : ""}`,
          ),
        ].join("\n")
      : "В дневнике пока нет тренировок.",
  };
}
export function compareWorkouts(workouts, firstId, secondId) {
  if (firstId === secondId)
    throw new Error("Для сравнения нужны две разные тренировки.");
  const found = [
    workouts.find((w) => w.id === firstId),
    workouts.find((w) => w.id === secondId),
  ];
  if (found.some((w) => !w))
    throw new Error("Одна из выбранных тренировок не найдена.");
  const [first, second] = found.sort((a, b) => a.date.localeCompare(b.date));
  if (
    found.some((w) => w.sport !== "run" || !w.distanceKm || !w.durationSeconds)
  )
    throw new Error("Нужны две пробежки с дистанцией и длительностью.");
  const ratio =
    Math.max(first.distanceKm, second.distanceKm) /
    Math.min(first.distanceKm, second.distanceKm);
  if (ratio > 1.1)
    throw new Error(
      "Для этого сравнения выбери пробежки с разницей дистанций не больше 10%.",
    );
  const firstPace = first.durationSeconds / first.distanceKm,
    secondPace = second.durationSeconds / second.distanceKm;
  const delta = Math.round(secondPace - firstPace);
  const direction =
    delta < 0
      ? `меньше на ${Math.abs(delta)} сек/км`
      : delta > 0
        ? `больше на ${delta} сек/км`
        : "не изменился после округления";
  return {
    title: "Сравнение пробежек",
    verified: true,
    sources: [source(first), source(second)],
    sourceCount: 2,
    metrics: {
      firstPaceSeconds: Math.round(firstPace),
      secondPaceSeconds: Math.round(secondPace),
      paceDeltaSeconds: delta,
    },
    reply: [
      `Сравнение пробежек`,
      `${first.date}: ${decimal(first.distanceKm)} км, ${formatTime(first.durationSeconds)}, темп ${formatTime(firstPace)} /км.`,
      `${second.date}: ${decimal(second.distanceKm)} км, ${formatTime(second.durationSeconds)}, темп ${formatTime(secondPace)} /км.`,
      `Темп второй записи ${direction}.`,
      "Маршрут, погода и усилие не учтены; вывод об изменении физической формы не делается.",
    ].join("\n"),
  };
}
export function latestComparablePair(workouts) {
  const runs = [...workouts]
    .filter(
      (w) => w.id && w.sport === "run" && w.distanceKm && w.durationSeconds,
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++) {
      if (
        Math.max(runs[i].distanceKm, runs[j].distanceKm) /
          Math.min(runs[i].distanceKm, runs[j].distanceKm) <=
        1.1
      )
        return [runs[j].id, runs[i].id];
    }
  return null;
}
