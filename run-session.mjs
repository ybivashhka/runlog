import { randomUUID } from "node:crypto";

const key = "active_run";
export function elapsedSeconds(session, now = Date.now()) {
  if (!session) return 0;
  return Math.max(0, Math.round((session.elapsedMs +
    (session.status === "running" ? now - session.resumedAt : 0)) / 1000));
}
export function runSession(store, action, { now = Date.now(), date } = {}) {
  let session = store.getSetting(key);
  if (action === "start") {
    if (session) throw new Error("Уже есть незавершённая пробежка. Продолжи или заверши её.");
    session = { id: randomUUID(), date, startedAt: now, resumedAt: now,
      elapsedMs: 0, status: "running" };
  } else if (action === "discard") {
    store.setSetting(key, null);
    return null;
  } else {
    if (!session) throw new Error("Сначала начни пробежку.");
    if (session.status === "finished" && action !== "finish")
      throw new Error("Пробежка уже завершена. Сохрани результат или сбрось таймер.");
    if (action === "pause" || action === "finish") {
      if (session.status === "running") session.elapsedMs += Math.max(0, now - session.resumedAt);
      session.status = action === "finish" ? "finished" : "paused";
    } else if (action === "resume") {
      if (session.status !== "paused") throw new Error("Продолжить можно пробежку на паузе.");
      session.resumedAt = now;
      session.status = "running";
    } else throw new Error("Неизвестное действие пробежки.");
  }
  store.setSetting(key, session);
  return { ...session, durationSeconds: elapsedSeconds(session, now) };
}

export function parseQuickRun(text, today) {
  // Explicit command: /log 3,2 24:30 [note]. No inferred distance or GPS data.
  const match = text.match(/^\/log(?:@\w+)?\s+(\d+(?:[.,]\d+)?)\s+(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\s+([\s\S]*))?$/);
  if (!match || Number(match[4]) >= 60 || (match[2] && Number(match[3]) >= 60))
    throw new Error("Формат: /log 3,2 24:30 — километры и минуты:секунды. Для часа: /log 10 1:05:00");
  return { date: today, sport: "run", distanceKm: Number(match[1].replace(",", ".")),
    durationSeconds: Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4]),
    avgHR: null, notes: match[5] || "", imageId: null };
}
