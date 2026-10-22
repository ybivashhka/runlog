import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseActivityImport } from "./activity.mjs";

export function defaultSyncFile() {
  return (
    process.env.RUNLOG_SYNC_FILE ||
    (process.platform === "darwin"
      ? path.join(
          os.homedir(),
          "Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/runlog-health.json",
        )
      : null)
  );
}

// A single known file is read; the rest of iCloud Drive is never scanned.
export function createHealthSync({
  store,
  file = defaultSyncFile(),
  source,
  onImport = () => {},
  intervalMs = 15000,
  now = () => new Date(),
}) {
  let timer,
    running = false,
    stopped = false,
    signature = null;
  const state = {
    enabled: Boolean(file),
    status: file ? "waiting" : "disabled",
    lastCheckedAt: null,
    error: null,
  };
  async function scan() {
    if (!file || running || stopped) return state;
    running = true;
    state.lastCheckedAt = new Date().toISOString();
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 8 * 1024 * 1024)
        throw new Error("Файл синхронизации отсутствует или слишком большой.");
      const current = `${info.mtimeMs}:${info.size}`;
      if (current !== signature) {
        const text = await readFile(file, "utf8");
        const after = await stat(file);
        if (`${after.mtimeMs}:${after.size}` !== current) return state;
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
      if (!timer && file) {
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
