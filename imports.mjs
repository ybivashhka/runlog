import { XMLParser, XMLValidator } from "fast-xml-parser";
import { validateWorkout } from "./core.mjs";

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const numeric = (x) =>
  x == null || x === "" ? null : Number(String(x).replace(",", "."));
function distance(value, unit = "km") {
  const n = numeric(value);
  if (n === null) return null;
  if (["km", "Kilometer"].includes(unit)) return n;
  if (["m", "Meter"].includes(unit)) return n / 1000;
  if (["mi", "mile"].includes(unit)) return n * 1.609344;
  throw new Error(`Неизвестная единица дистанции: ${unit}`);
}
function seconds(value, unit = "s") {
  const n = numeric(value);
  if (n === null) return null;
  if (["s", "sec"].includes(unit)) return n;
  if (["min", "minute"].includes(unit)) return n * 60;
  if (["h", "hr"].includes(unit)) return n * 3600;
  throw new Error(`Неизвестная единица времени: ${unit}`);
}
function appleWorkout(w) {
  const stats = asArray(w.WorkoutStatistics);
  const metric = (type) => stats.find((s) => s.type === type);
  const d = metric(
    w.workoutActivityType === "HKWorkoutActivityTypeCycling"
      ? "HKQuantityTypeIdentifierDistanceCycling"
      : "HKQuantityTypeIdentifierDistanceWalkingRunning",
  );
  const hr = metric("HKQuantityTypeIdentifierHeartRate");
  const sport =
    {
      HKWorkoutActivityTypeRunning: "run",
      HKWorkoutActivityTypeWalking: "walk",
      HKWorkoutActivityTypeCycling: "cycle",
      HKWorkoutActivityTypeTraditionalStrengthTraining: "strength",
      HKWorkoutActivityTypeFunctionalStrengthTraining: "strength",
    }[w.workoutActivityType] || "other";
  return {
    date: String(w.startDate || "").slice(0, 10),
    sport,
    distanceKm:
      w.totalDistance != null
        ? distance(w.totalDistance, w.totalDistanceUnit)
        : d
          ? distance(d.sum, d.unit)
          : null,
    durationSeconds: seconds(w.duration, w.durationUnit || "min"),
    avgHR:
      hr && ["count/min", "bpm"].includes(hr.unit) ? numeric(hr.average) : null,
    notes: "Apple Health",
    imageId: null,
  };
}
export function parseWorkoutImport(text, filename = "") {
  if (typeof text !== "string" || Buffer.byteLength(text) > 8 * 1024 * 1024)
    throw new Error("Импорт поддерживает файлы до 8 МБ.");
  let raw;
  if (text.trimStart().startsWith("<")) {
    if (/<!ENTITY\b|<!DOCTYPE[^[]*\b(?:SYSTEM|PUBLIC)\b/i.test(text))
      throw new Error("XML с внешними сущностями не поддерживается.");
    if (XMLValidator.validate(text) !== true)
      throw new Error("Некорректный XML.");
    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      processEntities: false,
    }).parse(text);
    raw = asArray(parsed.HealthData?.Workout).map(appleWorkout);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        "Поддерживается Apple Health XML или JSON со списком workouts.",
      );
    }
    raw = Array.isArray(parsed) ? parsed : parsed.workouts;
    if (!Array.isArray(raw)) throw new Error("В JSON нужен массив workouts.");
  }
  if (!raw.length) throw new Error("В файле нет тренировок.");
  if (raw.length > 500)
    throw new Error("Раздели импорт на файлы не более 500 тренировок.");
  const workouts = [],
    errors = [];
  for (const [i, w] of raw.entries()) {
    try {
      workouts.push(validateWorkout({ ...w, imageId: null }));
    } catch (e) {
      errors.push({ row: i + 1, reason: e.message });
    }
  }
  if (!workouts.length)
    throw new Error(
      "Не найдено тренировок с корректной датой и длительностью или дистанцией.",
    );
  return {
    workouts,
    skipped: errors.length,
    errors: errors.slice(0, 10),
    filename: String(filename)
      .replace(/[^\w. -]/g, "_")
      .slice(0, 100),
  };
}
