import { mkdir, readFile, open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createStore } from "./store.mjs";
import { TelegramAPI } from "./telegram-api.mjs";
import { runAgent } from "./agent.mjs";
import {
  buildReport,
  buildHistory,
  compareWorkouts,
  latestComparablePair,
  formatTime,
} from "./reports.mjs";
import { activityReport } from "./activity.mjs";
import { createHealthSync } from "./sync.mjs";
import { parseWorkoutImport } from "./imports.mjs";
import { dataDirectory } from "./config.mjs";
import { runSession, elapsedSeconds, parseQuickRun } from "./run-session.mjs";
import { recognizeLocally } from "./ocr.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
export function currentDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.SPORT_TIMEZONE || "Asia/Saigon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
const button = (text, action, id) => ({
  text,
  callback_data: `${action}:${id}`,
});
const HELP =
  "RUNLOG\n\n/run — начать таймер пробежки\n/pause · /resume — пауза и продолжение\n/finish — закончить и указать дистанцию\n/log 3,2 24:30 — добавить 3,2 км за 24:30 без ИИ\n\nФото дорожки → распознавание → проверка → сохранение.\n/activity — шаги за 7 дней\n/summary — сводка за 30 дней\n/history — история\n/compare — сопоставимые пробежки\n/photos — фото формы\n/export — выгрузить записи\n/cancel — отменить ввод\n\nТаймер считает время между командами; GPS-дистанцию он не измеряет. Дневник работает, пока RUNLOG запущен на Mac.";

export function createBotHandler({
  api,
  store,
  ownerId,
  directory,
  agent = runAgent,
  today = currentDate,
  now = () => Date.now(),
}) {
  if (!/^\d+$/.test(String(ownerId || "")))
    throw new Error("Укажи TELEGRAM_OWNER_ID. Запусти npm run setup:telegram.");
  const editingKey = `telegram_edit:${ownerId}`;
  async function showDraft(chatId, draft) {
    const p = draft.payload;
    let text;
    if (p.kind === "workout") {
      const w = p.workout;
      text = [
        "Проверь тренировку",
        `Дата: ${w.date || "не указана"}`,
        `Дистанция: ${w.distanceKm ?? "не указана"} км`,
        `Длительность: ${formatTime(w.durationSeconds)}`,
        `Средний пульс: ${w.avgHR ?? "не указан"}`,
        ...(w.warnings || []),
      ].join("\n");
    } else if (p.kind === "photo")
      text = `Фото формы\nДата: ${p.photo.date}\nВес: ${p.photo.weightKg ?? "не указан"}\nСохранить в личный дневник?`;
    else
      text = `Импорт: ${p.workouts.length} тренировок\nПропущено некорректных записей: ${p.skipped || 0}\n${p.workouts
        .slice(0, 4)
        .map(
          (w) =>
            `${w.date}: ${w.distanceKm ?? "—"} км, ${formatTime(w.durationSeconds)}`,
        )
        .join("\n")}\nДубли не будут добавлены.`;
    const rows = [];
    if (p.kind === "workout" && !p.workout.date)
      rows.push([button("Дата: сегодня", "today", draft.id)]);
    rows.push([
      button("Сохранить", "save", draft.id),
      button("Отмена", "cancel", draft.id),
    ]);
    if (p.kind === "workout")
      rows.push([button("Исправить показатели", "edit", draft.id)]);
    return api.send(chatId, text, { inline_keyboard: rows });
  }
  async function extract(chatId, draft, correction) {
    const p = draft.payload;
    await api.send(chatId, "Распознаю показатели…");
    if (p.imageId && !correction && process.platform === "darwin") {
      try {
        const local = await recognizeLocally(store.imagePath(p.imageId), store.directory);
        if (local.draft.distanceKm || local.draft.durationSeconds) {
          const updated = store.changeDraft(draft.id, ownerId, {
            kind: "workout", imageId: p.imageId,
            workout: { ...local.draft, imageId: p.imageId },
          });
          await showDraft(chatId, updated);
          return;
        }
      } catch { /* Model recognition remains an explicit workout action. */ }
    }
    const text = correction
      ? `Исправь предыдущий черновик ${JSON.stringify(p.workout)}. Указание пользователя: ${correction}`
      : p.caption || "Распознай тренировку на снимке.";
    const result = await agent({
      text,
      imagePath: p.imageId ? store.imagePath(p.imageId) : null,
      imageId: p.imageId || null,
      store,
      directory,
      today: today(),
    });
    if (!result.draft) {
      await api.send(chatId, result.reply);
      return;
    }
    const updated = store.changeDraft(draft.id, ownerId, {
      kind: "workout",
      imageId: p.imageId || null,
      workout: result.draft,
    });
    await showDraft(chatId, updated);
  }
  return async function handle(update) {
    const callback = update.callback_query,
      message = callback?.message || update.message;
    const from = callback?.from || message?.from;
    if (
      !message ||
      String(from?.id) !== String(ownerId) ||
      message.chat?.type !== "private" ||
      String(message.chat.id) !== String(ownerId)
    ) {
      if (callback)
        await api
          .call("answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Личный бот. Доступ ограничен.",
          })
          .catch(() => {});
      return;
    }
    if (store.hasUpdate(update.update_id)) return;
    const chatId = message.chat.id;
    const eventTime = Number.isFinite(message.date) && message.date > 0
      ? Math.min(now(), message.date * 1000) : now();
    try {
      if (callback) {
        await api.call("answerCallbackQuery", {
          callback_query_id: callback.id,
        });
        const [action, id] = String(callback.data || "").split(":");
        const draft = store.getDraft(id, ownerId);
        if (!draft)
          throw new Error("Черновик не найден. Отправь снимок ещё раз.");
        if (action === "save") {
          const result = store.confirmDraft(id, ownerId);
          if (draft.payload.runSessionId === store.getSetting("active_run")?.id)
            runSession(store, "discard");
          store.setSetting(editingKey, null);
          await api.send(
            chatId,
            result.alreadySaved
              ? "Эта запись уже сохранена."
              : result.imported != null
                ? `Импортировано: ${result.imported}. Дубли: ${result.duplicates}.`
                : "Сохранено в дневник.",
          );
        } else if (action === "cancel") {
          await store.cancelDraft(id, ownerId);
          store.setSetting(editingKey, null);
          await api.send(chatId, "Черновик отменён.");
        } else if (action === "edit") {
          if (draft.status !== "pending")
            throw new Error("Запись уже обработана.");
          store.setSetting(editingKey, id);
          await api.send(
            chatId,
            "Напиши исправление, например: «дата 2026-10-22, дистанция 3,2 км, время 24 минуты». Затем проверь новый черновик.",
          );
        } else if (action === "today") {
          const next = store.changeDraft(id, ownerId, {
            ...draft.payload,
            workout: { ...draft.payload.workout, date: today() },
          });
          await showDraft(chatId, next);
        } else if (action === "workout") await extract(chatId, draft);
        else if (action === "body") {
          const next = store.changeDraft(id, ownerId, {
            kind: "photo",
            imageId: draft.payload.imageId,
            photo: {
              imageId: draft.payload.imageId,
              date: today(),
              weightKg: null,
              notes: draft.payload.caption || "",
            },
          });
          await showDraft(chatId, next);
        } else throw new Error("Неизвестное действие.");
        if (["save", "cancel"].includes(action))
          await api
            .call("editMessageReplyMarkup", {
              chat_id: chatId,
              message_id: message.message_id,
              reply_markup: { inline_keyboard: [] },
            })
            .catch(() => {});
      } else {
        const text = String(message.text || "").trim();
        if (/^\/(start|help)(?:@\w+)?(?:\s|$)/.test(text))
          await api.send(chatId, HELP);
        else if (/^\/log(?:@\w+)?(?:\s|$)/.test(text)) {
          const workout = parseQuickRun(text, today());
          const draft = store.createDraft(ownerId, { kind: "workout", workout }, `telegram:${update.update_id}`);
          await showDraft(chatId, draft);
        } else if (["/run", "/pause", "/resume", "/finish"].includes(text)) {
          const action = { "/run": "start", "/pause": "pause", "/resume": "resume", "/finish": "finish" }[text];
          const session = runSession(store, action, { now: eventTime, date: today() });
          if (action === "finish") {
            store.setSetting(`run_distance:${ownerId}`, session.id);
            await api.send(chatId, `Таймер остановлен: ${formatTime(session.durationSeconds)}.\nСколько километров пробежал? Отправь число, например 3,2. Если дистанция неизвестна — /nodistance.`);
          } else await api.send(chatId,
            action === "start" ? "Таймер запущен. /pause — пауза, /finish — закончить. Телефон можно заблокировать: время сохранится."
              : `${action === "pause" ? "Пауза" : "Продолжаем"}. Время: ${formatTime(session.durationSeconds)}.`,
          );
        } else if (text === "/runstatus") {
          const session = store.getSetting("active_run");
          await api.send(chatId, session ? `Пробежка: ${formatTime(elapsedSeconds(session, now()))}. ${session.status === "running" ? "Таймер идёт." : "Таймер остановлен."}` : "Активной пробежки нет. /run — начать.");
        } else if (text === "/discardrun") {
          runSession(store, "discard");
          store.setSetting(`run_distance:${ownerId}`, null);
          await api.send(chatId, "Незавершённая пробежка удалена. История сохранённых тренировок не изменена.");
        }
        else if (text === "/activity")
          await api.send(
            chatId,
            activityReport(store.listActivity(), { today: today() }).reply,
          );
        else if (text.startsWith("/summary")) {
          const arg = text.split(/\s+/)[1];
          const days = arg === "all" ? null : arg ? Number(arg) : 30;
          await api.send(
            chatId,
            buildReport(store.listWorkouts(), { today: today(), days }).reply,
          );
        } else if (text === "/history")
          await api.send(chatId, buildHistory(store.listWorkouts()).reply);
        else if (text === "/compare") {
          const all = store.listWorkouts(),
            pair = latestComparablePair(all);
          await api.send(
            chatId,
            pair
              ? compareWorkouts(all, ...pair).reply
              : "Нужны две пробежки с временем и разницей дистанций не больше 10%.",
          );
        } else if (text === "/export")
          await api.sendFile(
            chatId,
            Buffer.from(
              JSON.stringify(
                {
                  version: 1,
                  workouts: store.listWorkouts(),
                  photos: store.listPhotos(),
                  activity: store.listActivity(),
                },
                null,
                2,
              ),
            ),
            "runlog.json",
          );
        else if (text === "/photos") {
          const photos = store.listPhotos().slice(-2);
          if (!photos.length)
            await api.send(
              chatId,
              "Фото формы пока нет. Отправь снимок и выбери «Фото формы».",
            );
          for (const p of photos) {
            const img = store.getImage(p.imageId);
            await api.sendFile(
              chatId,
              await readFile(store.imagePath(p.imageId)),
              `${p.date}.${img.filename.split(".").at(-1)}`,
              img.mime,
              `${p.date}${p.weightKg ? ` · ${p.weightKg} кг` : ""}`,
            );
          }
        } else if (text === "/cancel") {
          const id = store.getSetting(editingKey);
          if (id) await store.cancelDraft(id, ownerId);
          store.setSetting(editingKey, null);
          store.setSetting(`run_distance:${ownerId}`, null);
          await api.send(chatId, "Ввод исправлений отменён.");
        } else if (
          message.photo?.length ||
          (message.document &&
            /^image\/(jpeg|png|webp)$/.test(message.document.mime_type))
        ) {
          const file = message.photo?.at(-1) || message.document;
          if (file.file_size > 8 * 1024 * 1024)
            throw new Error("Файл должен быть не больше 8 МБ.");
          const bytes = await api.download(file.file_id),
            mime = message.photo ? "image/jpeg" : message.document.mime_type;
          const image = await store.saveImage(
            `data:${mime};base64,${bytes.toString("base64")}`,
          );
          const draft = store.createDraft(
            ownerId,
            {
              kind: "image",
              imageId: image.id,
              caption: message.caption || "",
            },
            `telegram:${update.update_id}`,
          );
          await api.send(chatId, "Что на снимке?", {
            inline_keyboard: [
              [
                button("Тренировка / дорожка", "workout", draft.id),
                button("Фото формы", "body", draft.id),
              ],
              [button("Отмена", "cancel", draft.id)],
            ],
          });
        } else if (
          message.document &&
          /\.(xml|json)$/i.test(message.document.file_name || "")
        ) {
          const bytes = await api.download(message.document.file_id),
            parsed = parseWorkoutImport(
              bytes.toString("utf8"),
              message.document.file_name,
            );
          const draft = store.createDraft(
            ownerId,
            { kind: "import", ...parsed },
            `telegram:${update.update_id}`,
          );
          await showDraft(chatId, draft);
        } else if (text) {
          const distanceSessionId = store.getSetting(`run_distance:${ownerId}`);
          const session = store.getSetting("active_run");
          if (distanceSessionId && session?.id === distanceSessionId &&
              (text === "/nodistance" || /^\d+(?:[.,]\d+)?(?:\s*км)?$/.test(text))) {
            const distanceKm = text === "/nodistance" ? null : Number(text.replace(/\s*км$/, "").replace(",", "."));
            const workout = { date: session.date, sport: "run", distanceKm,
              durationSeconds: elapsedSeconds(session, now()), avgHR: null,
              notes: "Время по таймеру RUNLOG; дистанция введена вручную.", imageId: null };
            const { validateWorkout } = await import("./core.mjs");
            validateWorkout(workout);
            const draft = store.createDraft(ownerId, { kind: "workout", workout, runSessionId: session.id });
            store.setSetting(`run_distance:${ownerId}`, null);
            await showDraft(chatId, draft);
            store.markUpdate(update.update_id);
            return;
          }
          const editId = store.getSetting(editingKey),
            old = editId && store.getDraft(editId, ownerId);
          if (old?.status === "pending" && !text.startsWith("/")) {
            await extract(chatId, old, text);
            store.setSetting(editingKey, null);
          } else if (text.startsWith("/"))
            await api.send(
              chatId,
              "Неизвестная команда. /help — список команд.",
            );
          else {
            await api.send(chatId, "Обрабатываю запрос…");
            const result = await agent({
              text,
              store,
              directory,
              today: today(),
            });
            if (result.draft) {
              const draft = store.createDraft(
                ownerId,
                { kind: "workout", workout: result.draft },
                `telegram:${update.update_id}`,
              );
              await showDraft(chatId, draft);
            } else await api.send(chatId, result.reply);
          }
        } else
          await api.send(
            chatId,
            "Отправь текст, фото тренировки или XML/JSON с тренировками.",
          );
      }
    } catch (error) {
      await api
        .send(chatId, `Не удалось выполнить действие: ${error.message}`)
        .catch(() => {});
    }
    store.markUpdate(update.update_id);
  };
}

export async function startBot({ signal, onReady = () => {}, onError = () => {} } = {}) {
  const api = new TelegramAPI(process.env.TELEGRAM_BOT_TOKEN);
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!/^\d+$/.test(ownerId || ""))
    throw new Error(
      "Запусти npm run setup:telegram для настройки личного доступа.",
    );
  const dataDir = dataDirectory();
  await mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "telegram.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    let live = true;
    try {
      const pid = Number(await readFile(lockPath, "utf8"));
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") live = false;
      }
    } catch {}
    if (live)
      throw new Error(
        "Бот уже запущен или остался lock-файл. Проверь процесс перед повторным запуском.",
      );
    await unlink(lockPath);
    lock = await open(lockPath, "wx", 0o600);
  }
  await lock.writeFile(String(process.pid));
  const store = await createStore(dataDir),
    directory = path.join(dataDir, "jobs");
  await mkdir(directory, { recursive: true });
  const sync = createHealthSync({ store });
  sync.start();
  const stop = new AbortController();
  if (signal?.aborted) stop.abort();
  const abort = () => stop.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const signalHandlers = ["SIGINT", "SIGTERM"].map(name => {
    const handler = () => stop.abort();
    process.once(name, handler);
    return [name, handler];
  });
  try {
    const me = await api.call("getMe"),
      webhook = await api.call("getWebhookInfo");
    if (webhook.url)
      throw new Error(
        "У бота уже настроен webhook. Используй отдельного бота или отключи webhook самостоятельно.",
      );
    console.log(`RUNLOG Telegram: @${me.username}. Личный доступ настроен.`);
    onReady(me);
    const handle = createBotHandler({ api, store, ownerId, directory });
    while (!stop.signal.aborted) {
      try {
        const updates = await api.call(
          "getUpdates",
          {
            offset: store.getSetting("telegram_offset") || 0,
            timeout: 25,
            allowed_updates: ["message", "callback_query"],
          },
          stop.signal,
        );
        onReady(me);
        for (const update of updates) {
          if (stop.signal.aborted) break;
          await handle(update);
          store.setSetting("telegram_offset", update.update_id + 1);
        }
      } catch (error) {
        if (stop.signal.aborted) break;
        console.error(error.message);
        onError(error.message);
        if (error.message === "Telegram API 409")
          throw new Error(
            "Другой процесс получает обновления этого бота. Останови второй экземпляр.",
          );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  } finally {
    for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
    signal?.removeEventListener("abort", abort);
    await sync.stop();
    store.close();
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startBot().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
