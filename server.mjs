import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createStore } from "./store.mjs";
import { summarize } from "./core.mjs";
import { runAgent } from "./agent.mjs";
import { parseWorkoutImport } from "./imports.mjs";
import { createHealthSync } from "./sync.mjs";
import { parseActivityImport } from "./activity.mjs";
import { dataDirectory } from "./config.mjs";
import { createTelegramConnection } from "./telegram-connection.mjs";
import { runSession, elapsedSeconds } from "./run-session.mjs";
import { recognizeLocally } from "./ocr.mjs";
import { buildReport, buildHistory, compareWorkouts, latestComparablePair } from "./reports.mjs";
import { activityReport } from "./activity.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.SPORT_TIMEZONE || "Asia/Saigon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((type) => parts.find((p) => p.type === type).value)
    .join("-");
}

export async function createApp({
  dataDir = dataDirectory(),
  model,
  syncFile,
  telegram = true,
} = {}) {
  const store = await createStore(dataDir);
  const bot = telegram ? createTelegramConnection({ store }) : null;
  const healthSync = createHealthSync({
    store,
    ...(syncFile !== undefined ? { file: syncFile } : {}),
  });
  // Start only when the application is actually serving.
  const jobsDir = path.join(dataDir, "jobs");
  await mkdir(jobsDir, { recursive: true });
  const token = randomBytes(24).toString("hex"),
    jobs = new Map();
  let busy = false;
  let codexStatus;
  async function checkCodex() {
    if (codexStatus && Date.now() - codexStatus.checked < 30000) return codexStatus.value;
    let available = false, authenticated = false;
    try {
      const r = await exec(process.env.SPORT_CODEX_BIN || "codex", ["login", "status"], { timeout: 6000 });
      available = true;
      authenticated = /logged in/i.test(r.stdout + r.stderr);
    } catch (e) { available = e.code !== "ENOENT"; }
    codexStatus = { checked: Date.now(), value: { available, authenticated } };
    return codexStatus.value;
  }
  const send = (
    res,
    status,
    data,
    type = "application/json; charset=utf-8",
  ) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
  };
  async function json(req) {
    if (!String(req.headers["content-type"]).startsWith("application/json"))
      throw new Error("Нужен JSON.");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) throw new Error("Файл слишком большой.");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new Error("Не удалось прочитать запрос.");
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host))
        return send(res, 403, { error: "Только локальный доступ." });
      if (
        req.headers.origin &&
        ![
          `http://${host}`,
          `http://127.0.0.1:${server.address().port}`,
          `http://localhost:${server.address().port}`,
        ].includes(req.headers.origin)
      )
        return send(res, 403, { error: "Недопустимый источник запроса." });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers["x-diary-token"] !== token
      )
        return send(res, 403, { error: "Обнови страницу и повтори действие." });
      const url = new URL(req.url, `http://${host}`),
        p = url.pathname;
      if (req.method === "GET" && p === "/api/status") {
        return send(res, 200, {
          token,
          today: today(),
          codex: await checkCodex(),
          telegram: bot?.state || { status: "disabled" },
          storage: "SQLite на этом компьютере",
          telegramUsername: /^[A-Za-z0-9_]+$/.test(
            process.env.TELEGRAM_BOT_USERNAME || "",
          )
            ? process.env.TELEGRAM_BOT_USERNAME
            : null,
        });
      }
      if (req.method === "GET" && p === "/api/diary") {
        const workouts = store.listWorkouts();
        return send(res, 200, {
          workouts,
          photos: store.listPhotos(),
          summary: summarize(workouts),
          activity: store.listActivity(),
          sync: {
            ...healthSync.state,
            lastImport: store.getSetting("health_sync"),
          },
          telegram: bot?.state || { status: "disabled" },
          activeRun: store.getSetting("active_run") ? {
            ...store.getSetting("active_run"),
            durationSeconds: elapsedSeconds(store.getSetting("active_run")),
          } : null,
        });
      }
      if (req.method === "POST" && p === "/api/telegram/connect") {
        if (!bot) throw new Error("Telegram отключён в этом запуске.");
        const body = await json(req);
        return send(res, 200, await bot.pair(String(body.token || "").trim()));
      }
      if (req.method === "POST" && p === "/api/sync") {
        await healthSync.scan();
        return send(res, 200, healthSync.state);
      }
      if (req.method === "POST" && p === "/api/run") {
        const body = await json(req);
        return send(res, 200, { session: runSession(store, body.action, { date: today() }) });
      }
      if (req.method === "GET" && p === "/api/health")
        return send(res, 200, { ok: true });
      if (req.method === "GET" && p === "/api/report") {
        const type = url.searchParams.get("type");
        const all = store.listWorkouts();
        if (type === "history") return send(res, 200, buildHistory(all));
        if (type === "progress") return send(res, 200, buildReport(all, { today: today(), days: 30 }));
        if (type === "activity") return send(res, 200, activityReport(store.listActivity(), { today: today() }));
        if (type === "compare") {
          const pair = latestComparablePair(all);
          if (!pair) return send(res, 200, { reply: "Нужны две пробежки с временем и разницей дистанций не больше 10%.", sourceCount: 0 });
          return send(res, 200, compareWorkouts(all, ...pair));
        }
        throw new Error("Выбери историю, сводку, активность или сравнение.");
      }
      if (req.method === "GET" && p === "/api/export")
        return send(res, 200, {
          version: 1,
          exportedAt: new Date().toISOString(),
          workouts: store.listWorkouts(),
          photos: store.listPhotos(),
          activity: store.listActivity(),
          note: "Файлы изображений хранятся отдельно в каталоге images рядом с diary.sqlite.",
        });
      if (req.method === "POST" && p === "/api/images") {
        const body = await json(req);
        const image = await store.saveImage(body.dataUrl);
        return send(res, 201, { id: image.id });
      }
      if (req.method === "POST" && p === "/api/recognize-local") {
        const body = await json(req);
        const imagePath = store.imagePath(body.imageId);
        if (!imagePath) throw new Error("Добавь фото тренировки.");
        return send(res, 200, await recognizeLocally(imagePath, dataDir));
      }
      if (req.method === "GET" && /^\/images\/[\w-]+$/.test(p)) {
        const image = store.getImage(p.split("/").at(-1));
        if (!image) return send(res, 404, { error: "Фото не найдено." });
        return send(
          res,
          200,
          await readFile(store.imagePath(image.id)),
          image.mime,
        );
      }
      if (req.method === "POST" && p === "/api/workouts") {
        const body = await json(req);
        const saved = store.saveWorkout(body);
        if (body.runSessionId && body.runSessionId === store.getSetting("active_run")?.id)
          runSession(store, "discard");
        return send(res, 201, saved);
      }
      if (req.method === "PUT" && /^\/api\/workouts\/[\w-]+$/.test(p))
        return send(
          res,
          200,
          await store.updateWorkout(p.split("/").at(-1), await json(req)),
        );
      if (req.method === "POST" && p === "/api/import") {
        const body = await json(req);
        if (/runlog-health-v[12]/.test(String(body.text).slice(0, 500))) {
          const batch = parseActivityImport(body.text);
          const draft = store.createDraft("web", { kind: "activity", batch });
          return send(res, 200, { id: draft.id, kind: "activity", count: batch.rows.length,
            skipped: 0, errors: [], preview: batch.rows });
        }
        const parsed = parseWorkoutImport(body.text, body.filename);
        const draft = store.createDraft("web", { kind: "import", ...parsed });
        return send(res, 200, {
          id: draft.id,
          count: parsed.workouts.length,
          skipped: parsed.skipped,
          errors: parsed.errors,
          preview: parsed.workouts.slice(0, 10),
        });
      }
      if (req.method === "POST" && /^\/api\/imports\/[\w-]+\/confirm$/.test(p))
        return send(res, 200, store.confirmDraft(p.split("/")[3], "web"));
      if (req.method === "POST" && p === "/api/photos")
        return send(res, 201, store.savePhoto(await json(req)));
      if (
        req.method === "DELETE" &&
        /^\/api\/(workout|photo|image)\/[\w-]+$/.test(p)
      ) {
        const [, , kind, id] = p.split("/");
        if (kind === "image") await store.cleanupImage(id);
        else await store.remove(kind, id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/agent") {
        if (busy)
          return send(res, 429, {
            error: "Агент уже работает. Дождись ответа.",
          });
        const body = await json(req),
          text = String(body.text || "").trim();
        if (text.length > 6000)
          throw new Error("Сократи запрос до 6000 символов.");
        const imagePath = body.imageId ? store.imagePath(body.imageId) : null;
        if (body.imageId && !imagePath) throw new Error("Снимок не найден.");
        if (!text && !imagePath)
          throw new Error("Напиши запрос или добавь снимок.");
        const id = randomUUID(),
          job = { id, status: "running", trace: [], result: null, error: null };
        if (jobs.size >= 30) {
          const old = [...jobs.values()].find((j) => j.status !== "running");
          if (old) jobs.delete(old.id);
        }
        jobs.set(id, job);
        busy = true;
        runAgent({
          text,
          imagePath,
          imageId: body.imageId || null,
          store,
          directory: jobsDir,
          today: today(),
          model,
          onTrace: (entry) => job.trace.push(entry),
        })
          .then((result) => {
            job.result = result;
            job.status = "done";
          })
          .catch((error) => {
            job.error = error.message;
            job.status = "error";
          })
          .finally(() => {
            busy = false;
          });
        return send(res, 202, { id });
      }
      if (req.method === "GET" && /^\/api\/jobs\/[\w-]+$/.test(p)) {
        const job = jobs.get(p.split("/").at(-1));
        return send(
          res,
          job ? 200 : 404,
          job || { error: "Запрос не найден." },
        );
      }
      if (req.method === "GET" && p === "/downloads/health-sync.shortcut") {
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="RUNLOG Health Sync.shortcut"',
        );
        return send(
          res,
          200,
          await readFile(
            path.join(root, "shortcuts", "RUNLOG Health Sync.shortcut"),
          ),
          "application/octet-stream",
        );
      }
      const files = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      if (req.method === "GET" && files[p]) {
        const [filename, type] = files[p];
        return send(
          res,
          200,
          await readFile(path.join(root, "public", filename)),
          type,
        );
      }
      return send(res, 404, { error: "Не найдено." });
    } catch (error) {
      return send(res, 400, {
        error: error.message || "Не удалось выполнить действие.",
      });
    }
  });
  server.once("listening", () => { healthSync.start(); bot?.start(); });
  server.on("close", () => { healthSync.stop(); bot?.stop(); });
  async function close() {
    await bot?.stop();
    await healthSync.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
  }
  return { server, store, healthSync, bot, close };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const { server } = app;
  const port = Number(process.env.SPORT_PORT || 8787);
  server.listen(port, "127.0.0.1", () =>
    console.log(`RUNLOG → http://127.0.0.1:${port}`),
  );
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? `Порт ${port} уже занят. Останови предыдущий RUNLOG.` : error.message);
    app.close().finally(() => { process.exitCode = 1; });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close());
}
