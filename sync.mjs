import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseActivityImport } from "./activity.mjs";

export function defaultSyncFiles() {
  if (process.env.RUNLOG_SYNC_FILE) return [process.env.RUNLOG_SYNC_FILE];
  if (process.platform !== "darwin") return [];
  return [
    path.join(
      os.homedir(),
      "Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/runlog-health.json",
    ),
    path.join(
      os.homedir(),
      "Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/runlog-health.json",
    ),
  ];
}

// Only these exact filenames are checked; iCloud Drive is never scanned.
export function createHealthSync({
  store,
  file = defaultSyncFiles(),
  source,
  onImport = () => {},
  intervalMs = 15000,
  now = () => new Date(),
}) {
  const files = (Array.isArray(file) ? file : [file]).filter(Boolean);
  let timer,
    running = false,
    stopped = false,
    signature = null;
  const state = {
    enabled: Boolean(files.length),
    status: files.length ? "waiting" : "disabled",
    lastCheckedAt: null,
    error: null,
  };
  async function scan() {
    if (!files.length || running || stopped) return state;
    running = true;
    state.lastCheckedAt = new Date().toISOString();
    try {
      const candidates = await Promise.all(
        files.map(async (filename) => {
          try {
            return { filename, info: await stat(filename) };
          } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          }
        }),
      );
      const entry = candidates
        .filter(Boolean)
        .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0];
      if (!entry) {
        const missing = new Error("Ожидаем файл с iPhone.");
        missing.code = "ENOENT";
        throw missing;
      }
      const { filename, info } = entry;
      if (!info.isFile() || info.size > 8 * 1024 * 1024)
        throw new Error("Файл синхронизации отсутствует или слишком большой.");
      const stamp = `${info.mtimeMs}:${info.size}`;
      const current = `${filename}:${stamp}`;
      if (current !== signature) {
        const text = await readFile(filename, "utf8");
        const after = await stat(filename);
        if (`${after.mtimeMs}:${after.size}` !== stamp) return state;
        if (stopped) return state;
        const batch = parseActivityImport(text, { source, now: now() });
        const result = store.importActivity(batch);
        signature = current;
        state.status = "synced";
        state.error = null;
        if (result.changed) await onImport(batch, result);
      }
    } catch (error) {
      state.status = error.code === "ENOENT" ? "waiting" : "error";
      state.error = error.code === "ENOENT" ? null : error.message;
    } finally {
      running = false;
    }
    return state;
  }
  return {
    state,
    scan,
    start() {
      if (!timer && files.length) {
        stopped = false;
        scan();
        timer = setInterval(scan, intervalMs);
        timer.unref();
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      while (running) await new Promise((r) => setTimeout(r, 10));
    },
  };
}
