import { createHash } from "node:crypto";

export const sports = ["run", "walk", "cycle", "strength", "other"];
export const labels = {
  run: "Бег",
  walk: "Ходьба",
  cycle: "Велосипед",
  strength: "Силовая",
  other: "Другое",
};

export function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Укажи дату в формате ГГГГ-ММ-ДД.");
  const d = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new Error("Такой даты не существует.");
  return value;
}

function number(value, name, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const n =
    typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name}: допустимо от ${min} до ${max}.`);
  return n;
}

export function validateWorkout(input) {
  if (!input || typeof input !== "object" || !sports.includes(input.sport))
    throw new Error("Выбери тип тренировки.");
  const result = {
    date: dateOnly(input.date),
    sport: input.sport,
    distanceKm: number(input.distanceKm, "Дистанция, км", 0.01, 1000),
    durationSeconds: number(
      input.durationSeconds,
      "Длительность, сек",
      1,
      604800,
    ),
    avgHR: number(input.avgHR, "Средний пульс", 20, 260),
    notes: String(input.notes ?? "").slice(0, 1000),
    imageId: input.imageId || null,
  };
  if (!result.distanceKm && !result.durationSeconds)
    throw new Error("Укажи дистанцию или длительность.");
  return result;
}

export function imageBuffer(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Нет изображения.");
  const match = dataUrl.match(
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/,
  );
  if (!match) throw new Error("Поддерживаются PNG, JPEG и WebP.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024)
    throw new Error("Фото должно быть не больше 8 МБ.");
  const type = match[1];
  const valid =
    type === "png"
      ? buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === "jpeg"
        ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
        : buffer.subarray(0, 4).toString() === "RIFF" &&
          buffer.subarray(8, 12).toString() === "WEBP";
  if (!valid)
    throw new Error("Содержимое файла не соответствует формату изображения.");
  return {
    buffer,
    mime: `image/${type}`,
    extension: type === "jpeg" ? "jpg" : type,
    hash: createHash("sha256").update(buffer).digest("hex"),
  };
}

export function summarize(workouts) {
  const ordered = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  const runs = ordered.filter((w) => w.sport === "run");
  const timed = runs.filter((w) => w.distanceKm > 0 && w.durationSeconds > 0);
  const totalKm = runs.reduce((sum, w) => sum + (w.distanceKm || 0), 0);
  const weighted = timed.length
    ? timed.reduce((s, w) => s + w.durationSeconds, 0) /
      timed.reduce((s, w) => s + w.distanceKm, 0)
    : null;
  const weeks = {};
  for (const w of runs) {
    const d = new Date(`${w.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = d.toISOString().slice(0, 10);
    weeks[key] = (weeks[key] || 0) + (w.distanceKm || 0);
  }
  return {
    workouts: ordered.length,
    runs: runs.length,
    totalKm: +totalKm.toFixed(2),
    averagePaceSeconds: weighted ? Math.round(weighted) : null,
    weeklyKm: Object.entries(weeks).map(([week, km]) => ({
      week,
      km: +km.toFixed(2),
    })),
    paceHistory: timed.map((w) => ({
      date: w.date,
      distanceKm: w.distanceKm,
      paceSeconds: Math.round(w.durationSeconds / w.distanceKm),
      avgHR: w.avgHR,
    })),
    limitations: [
      "Темп зависит от дистанции, маршрута, погоды и интенсивности. Сравнение не доказывает изменение физической формы.",
      "Отсутствующие показатели исключены из соответствующих расчётов.",
    ],
  };
}
