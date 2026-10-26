import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { root } from "./config.mjs";
import { dateOnly } from "./core.mjs";
const exec = promisify(execFile);
const compilations = new Map();
export async function recognizeLocally(imagePath, dataDir) {
  if (process.platform !== "darwin") throw new Error("Локальное распознавание доступно на macOS. Используй ИИ или ручной ввод.");
  const source = path.join(root, "scripts", "ocr.swift");
  const bin = path.join(dataDir, "bin", "runlog-ocr");
  if (!compilations.has(bin)) compilations.set(bin, (async () => {
    await mkdir(path.dirname(bin), { recursive: true });
    const sourceInfo = await stat(source);
    const binaryInfo = await stat(bin).catch(() => null);
    if (!binaryInfo || binaryInfo.mtimeMs < sourceInfo.mtimeMs)
      await exec("/usr/bin/xcrun", ["swiftc", source, "-O", "-o", bin], { timeout: 60000, maxBuffer: 1024 * 1024 });
    return bin;
  })().catch(() => { compilations.delete(bin); throw new Error("Не удалось подготовить локальное распознавание. Нужны инструменты разработчика Apple Command Line Tools."); }));
  const binary = await compilations.get(bin);
  const { stdout } = await exec(binary, [imagePath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const lines = JSON.parse(stdout).filter(line => line.confidence >= 0.3);
  return { lines, text: lines.map(line => line.text).join("\n"), draft: parseRecognizedText(lines) };
}

export function parseRecognizedText(lines) {
  const draft = { date: null, sport: "run", distanceKm: null, durationSeconds: null,
    avgHR: null, notes: "", warnings: [] };
  const distances = new Set(), durations = new Set(), dates = new Set();
  const number = s => Number(s.replace(",", "."));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text.trim();
    // Only explicit labels/units. Nearby unlabeled numbers are never guessed.
    const distance = text.match(/(?:distance|дистанц\S*|расстояни\S*)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(km|км|mi|миль|m|м)(?=\s|$|[,;])/i)
      || text.match(/^(\d+(?:[.,]\d+)?)\s*(km|км|mi|миль)\s*$/i);
    if (distance) {
      const unit = distance[2].toLowerCase();
      const value = number(distance[1]) * (unit === "m" || unit === "м" ? .001 : /mi|миль/.test(unit) ? 1.609344 : 1);
      if (value > 0 && value <= 1000) distances.add(Math.round(value * 1e5) / 1e5);
    }
    const duration = text.match(/(?:duration|elapsed|time|длительност\S*|время)\s*[:=]?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?!\d)/i);
    if (duration && !/pace|темп/i.test(text) && Number(duration[3]) < 60 &&
        (!duration[1] || Number(duration[2]) < 60)) {
      const value = Number(duration[1] || 0) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
      if (value > 0 && value <= 604800) durations.add(value);
    }
    const date = text.match(/(?:date|дата)\s*[:=]?\s*(\d{4}-\d{2}-\d{2})/i);
    if (date) { try { dates.add(dateOnly(date[1])); } catch {} }
  }
  if (distances.size === 1) draft.distanceKm = [...distances][0];
  if (durations.size === 1) draft.durationSeconds = [...durations][0];
  if (dates.size === 1) draft.date = [...dates][0];
  if (distances.size > 1 || durations.size > 1 || dates.size > 1)
    draft.warnings.push("На фото несколько разных значений. Неоднозначные поля оставлены пустыми.");
  if (!draft.distanceKm) draft.warnings.push("Дистанция не найдена однозначно. Введи её по дисплею.");
  if (!draft.durationSeconds) draft.warnings.push("Длительность не найдена однозначно. Не перепутай её с темпом.");
  return draft;
}
