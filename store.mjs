import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dateOnly, imageBuffer, validateWorkout } from "./core.mjs";

export async function createStore(directory) {
  await mkdir(path.join(directory, "images"), { recursive: true });
  const db = new DatabaseSync(path.join(directory, "diary.sqlite"));
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS workouts (id TEXT PRIMARY KEY, date TEXT NOT NULL, sport TEXT NOT NULL, distanceKm REAL, durationSeconds REAL, avgHR REAL, notes TEXT, imageId TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, date TEXT NOT NULL, imageId TEXT NOT NULL UNIQUE, weightKg REAL, notes TEXT);`);
  return {
    db,
    directory,
    listWorkouts() {
      return db
        .prepare("SELECT * FROM workouts ORDER BY date DESC, rowid DESC")
        .all();
    },
    saveWorkout(input) {
      const w = validateWorkout(input);
      if (
        w.imageId &&
        !db.prepare("SELECT id FROM images WHERE id = ?").get(w.imageId)
      )
        throw new Error("Исходный снимок не найден.");
      if (
        w.imageId &&
        db.prepare("SELECT id FROM workouts WHERE imageId = ?").get(w.imageId)
      )
        throw new Error("Тренировка с этим снимком уже сохранена.");
      const same = db
        .prepare(
          "SELECT id FROM workouts WHERE date = ? AND sport = ? AND distanceKm IS ? AND durationSeconds IS ?",
        )
        .get(w.date, w.sport, w.distanceKm, w.durationSeconds);
      if (same && !input.allowDuplicate)
        throw new Error(
          "Похожая тренировка уже есть. Проверь дату, дистанцию и время.",
        );
      const id = randomUUID();
      db.prepare("INSERT INTO workouts VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        w.date,
        w.sport,
        w.distanceKm,
        w.durationSeconds,
        w.avgHR,
        w.notes,
        w.imageId,
      );
      return { id, ...w };
    },
    async saveImage(dataUrl) {
      const { buffer, mime, extension, hash } = imageBuffer(dataUrl);
      const exists = db
        .prepare("SELECT * FROM images WHERE hash = ?")
        .get(hash);
      if (exists) return exists;
      const id = randomUUID(),
        filename = `${id}.${extension}`;
      await writeFile(path.join(directory, "images", filename), buffer, {
        mode: 0o600,
      });
      try {
        db.prepare("INSERT INTO images VALUES (?, ?, ?, ?)").run(
          id,
          filename,
          mime,
          hash,
        );
      } catch (error) {
        await unlink(path.join(directory, "images", filename)).catch(() => {});
        throw error;
      }
      return { id, filename, mime, hash };
    },
    getImage(id) {
      return db.prepare("SELECT * FROM images WHERE id = ?").get(id);
    },
    imagePath(id) {
      const image = this.getImage(id);
      return image ? path.join(directory, "images", image.filename) : null;
    },
    listPhotos() {
      return db.prepare("SELECT * FROM photos ORDER BY date, rowid").all();
    },
    savePhoto(input) {
      dateOnly(input.date);
      if (!this.getImage(input.imageId)) throw new Error("Фото не найдено.");
      const weight =
        input.weightKg === "" || input.weightKg == null
          ? null
          : Number(input.weightKg);
      if (
        weight !== null &&
        (!Number.isFinite(weight) || weight <= 0 || weight > 500)
      )
        throw new Error("Проверь значение веса.");
      if (
        db.prepare("SELECT id FROM photos WHERE imageId = ?").get(input.imageId)
      )
        throw new Error("Это фото уже есть в дневнике.");
      const id = randomUUID();
      db.prepare("INSERT INTO photos VALUES (?, ?, ?, ?, ?)").run(
        id,
        input.date,
        input.imageId,
        weight,
        String(input.notes || "").slice(0, 1000),
      );
      return { id };
    },
    async cleanupImage(id) {
      if (!id) return;
      if (
        db.prepare("SELECT id FROM workouts WHERE imageId = ?").get(id) ||
        db.prepare("SELECT id FROM photos WHERE imageId = ?").get(id)
      )
        return;
      const image = this.getImage(id);
      if (image) {
        db.prepare("DELETE FROM images WHERE id = ?").run(id);
        await unlink(path.join(directory, "images", image.filename)).catch(
          () => {},
        );
      }
    },
    async remove(kind, id) {
      const table =
        kind === "workout" ? "workouts" : kind === "photo" ? "photos" : null;
      if (!table) throw new Error("Неизвестная запись.");
      const row = db
        .prepare(`SELECT imageId FROM ${table} WHERE id = ?`)
        .get(id);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      await this.cleanupImage(row?.imageId);
    },
    close() {
      db.close();
    },
  };
}
