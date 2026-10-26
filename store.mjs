import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dateOnly, imageBuffer, validateWorkout } from "./core.mjs";

export async function createStore(directory) {
  await mkdir(path.join(directory, "images"), { recursive: true });
  const db = new DatabaseSync(path.join(directory, "diary.sqlite"));
  db.exec(`PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS workouts (id TEXT PRIMARY KEY, date TEXT NOT NULL, sport TEXT NOT NULL, distanceKm REAL, durationSeconds REAL, avgHR REAL, notes TEXT, imageId TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, date TEXT NOT NULL, imageId TEXT NOT NULL UNIQUE, weightKg REAL, notes TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_activity (date TEXT PRIMARY KEY, source TEXT NOT NULL, steps REAL, distanceKm REAL, sampleCount INTEGER NOT NULL, generatedAt TEXT NOT NULL, partial INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_updates (id INTEGER PRIMARY KEY, processedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', resultId TEXT, createdAt TEXT NOT NULL, sourceKey TEXT UNIQUE);`);
  return {
    db,
    directory,
    listActivity() {
      return db
        .prepare("SELECT * FROM daily_activity ORDER BY date DESC")
        .all()
        .map((r) => ({ ...r, partial: Boolean(r.partial) }));
    },
    importActivity(batch, { transaction = true } = {}) {
      if (transaction) db.exec("BEGIN IMMEDIATE");
      try {
        const previous = this.getSetting("health_sync");
        if (previous?.source && previous.source !== batch.source)
          throw new Error(
            "Источник активности изменился. Выбери прежний RUNLOG_HEALTH_SOURCE, чтобы не смешивать данные устройств.",
          );
        if (previous?.hash === batch.hash) {
          if (transaction) db.exec("COMMIT");
          return { changed: false, days: 0 };
        }
        let days = 0;
        for (const row of batch.rows) {
          // Discard the incomplete oldest edge of a rolling export. Never replace
          // yesterday's full snapshot with a smaller part of that same day.
          if (row.partial && row.date !== batch.generatedAt.slice(0, 10))
            continue;
          const old = db
            .prepare("SELECT generatedAt FROM daily_activity WHERE date=?")
            .get(row.date);
          if (old && Date.parse(old.generatedAt) >= Date.parse(row.generatedAt))
            continue;
          db.prepare(
            "INSERT INTO daily_activity VALUES (?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET source=excluded.source, steps=excluded.steps, distanceKm=excluded.distanceKm, sampleCount=excluded.sampleCount, generatedAt=excluded.generatedAt, partial=excluded.partial",
          ).run(
            row.date,
            row.source,
            row.steps,
            row.distanceKm,
            row.sampleCount,
            row.generatedAt,
            Number(row.partial),
          );
          days++;
        }
        if (
          !previous ||
          Date.parse(batch.generatedAt) > Date.parse(previous.generatedAt)
        )
          this.setSetting("health_sync", {
            generatedAt: batch.generatedAt,
            importedAt: new Date().toISOString(),
            source: batch.source,
            warnings: batch.warnings,
            hash: batch.hash,
          });
        if (transaction) db.exec("COMMIT");
        return { changed: days > 0, days };
      } catch (error) {
        if (transaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    listWorkouts() {
      return db
        .prepare("SELECT * FROM workouts ORDER BY date DESC, rowid DESC")
        .all();
    },
    getWorkout(id) {
      return db.prepare("SELECT * FROM workouts WHERE id = ?").get(id);
    },
    async updateWorkout(id, input) {
      const previous = this.getWorkout(id);
      if (!previous) throw new Error("Тренировка не найдена.");
      const w = validateWorkout(input);
      if (w.imageId && !this.getImage(w.imageId))
        throw new Error("Снимок не найден.");
      if (
        w.imageId &&
        db
          .prepare("SELECT id FROM workouts WHERE imageId = ? AND id != ?")
          .get(w.imageId, id)
      )
        throw new Error("Снимок уже связан с другой тренировкой.");
      if (
        db
          .prepare(
            "SELECT id FROM workouts WHERE id != ? AND date = ? AND sport = ? AND distanceKm IS ? AND durationSeconds IS ?",
          )
          .get(id, w.date, w.sport, w.distanceKm, w.durationSeconds)
      )
        throw new Error("Похожая тренировка уже есть.");
      db.prepare(
        "UPDATE workouts SET date=?, sport=?, distanceKm=?, durationSeconds=?, avgHR=?, notes=?, imageId=? WHERE id=?",
      ).run(
        w.date,
        w.sport,
        w.distanceKm,
        w.durationSeconds,
        w.avgHR,
        w.notes,
        w.imageId,
        id,
      );
      if (previous.imageId !== w.imageId)
        await this.cleanupImage(previous.imageId);
      return { id, ...w };
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
        const concurrent = db.prepare("SELECT * FROM images WHERE hash = ?").get(hash);
        if (concurrent) return concurrent;
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
      if (
        db
          .prepare("SELECT payload FROM drafts WHERE status = 'pending'")
          .all()
          .some((row) => {
            const p = JSON.parse(row.payload);
            return p.imageId === id || p.workout?.imageId === id;
          })
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
    getSetting(key) {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setSetting(key, value) {
      db.prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
    hasUpdate(id) {
      return Boolean(
        db.prepare("SELECT id FROM bot_updates WHERE id=?").get(id),
      );
    },
    markUpdate(id) {
      db.prepare("INSERT OR IGNORE INTO bot_updates VALUES (?,?)").run(
        id,
        new Date().toISOString(),
      );
    },
    getDraft(id, ownerId) {
      const row = db
        .prepare("SELECT * FROM drafts WHERE id=? AND ownerId=?")
        .get(id, String(ownerId));
      return row ? { ...row, payload: JSON.parse(row.payload) } : null;
    },
    createDraft(ownerId, payload, sourceKey = null) {
      if (sourceKey) {
        const old = db
          .prepare("SELECT id FROM drafts WHERE sourceKey=? AND ownerId=?")
          .get(sourceKey, String(ownerId));
        if (old) return this.getDraft(old.id, ownerId);
      }
      const id = randomUUID();
      db.prepare(
        "INSERT INTO drafts (id,ownerId,payload,createdAt,sourceKey) VALUES (?,?,?,?,?)",
      ).run(
        id,
        String(ownerId),
        JSON.stringify(payload),
        new Date().toISOString(),
        sourceKey,
      );
      return this.getDraft(id, ownerId);
    },
    changeDraft(id, ownerId, payload) {
      const draft = this.getDraft(id, ownerId);
      if (!draft || draft.status !== "pending")
        throw new Error("Черновик уже обработан или не найден.");
      db.prepare("UPDATE drafts SET payload=? WHERE id=? AND ownerId=?").run(
        JSON.stringify(payload),
        id,
        String(ownerId),
      );
      return this.getDraft(id, ownerId);
    },
    async cancelDraft(id, ownerId) {
      const draft = this.getDraft(id, ownerId);
      if (!draft || draft.status !== "pending") return;
      db.prepare(
        "UPDATE drafts SET status='cancelled' WHERE id=? AND ownerId=?",
      ).run(id, String(ownerId));
      await this.cleanupImage(
        draft.payload.imageId || draft.payload.workout?.imageId,
      );
    },
    confirmDraft(id, ownerId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const draft = this.getDraft(id, ownerId);
        if (!draft) throw new Error("Черновик не найден.");
        if (draft.status === "confirmed") {
          db.exec("COMMIT");
          return { id: draft.resultId, alreadySaved: true };
        }
        if (draft.status !== "pending") throw new Error("Черновик отменён.");
        let result;
        if (draft.payload.kind === "workout")
          result = this.saveWorkout(draft.payload.workout);
        else if (draft.payload.kind === "photo")
          result = this.savePhoto(draft.payload.photo);
        else if (draft.payload.kind === "activity") {
          const imported = this.importActivity(draft.payload.batch, { transaction: false });
          result = { id: randomUUID(), imported: imported.days, duplicates: 0, activity: true };
        } else if (draft.payload.kind === "import") {
          let imported = 0,
            duplicates = 0;
          for (const workout of draft.payload.workouts) {
            try {
              this.saveWorkout(workout);
              imported++;
            } catch (error) {
              if (/Похожая тренировка|уже сохранена/.test(error.message))
                duplicates++;
              else throw error;
            }
          }
          result = { id: randomUUID(), imported, duplicates };
        } else throw new Error("Сначала выбери тип снимка.");
        db.prepare(
          "UPDATE drafts SET status='confirmed', resultId=? WHERE id=? AND ownerId=?",
        ).run(result.id, id, String(ownerId));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
