import { randomBytes } from "node:crypto";
import { TelegramAPI } from "./telegram-api.mjs";
import { saveSettings } from "./config.mjs";
import { startBot } from "./telegram.mjs";

export function createTelegramConnection({ store, persist = saveSettings,
  apiFactory = token => new TelegramAPI(token), launch = startBot } = {}) {
  const state = { status: "disconnected", username: null, error: null };
  let pending, controller, task, stopped = false;
  function start() {
    if (task || stopped || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_OWNER_ID) return;
    controller = new AbortController();
    state.status = "connecting";
    state.username = process.env.TELEGRAM_BOT_USERNAME || null;
    task = launch({ signal: controller.signal,
      onReady: me => Object.assign(state, { status: "connected", username: me.username, error: null }),
      onError: error => Object.assign(state, { status: "reconnecting", error }),
    }).catch(error => {
      if (!stopped) Object.assign(state, { status: "error", error: error.message });
    }).finally(() => { task = null; });
  }
  async function pair(token) {
    if (stopped || pending || task) throw new Error("Бот уже подключается или работает. Дождись завершения подключения.");
    const api = apiFactory(token);
    const me = await api.call("getMe");
    const hook = await api.call("getWebhookInfo");
    if (hook.url) throw new Error("У этого бота уже есть webhook. Для RUNLOG нужен отдельный бот.");
    const challenge = randomBytes(16).toString("hex");
    const abort = new AbortController();
    pending = { api, abort, challenge, expires: Date.now() + 5 * 60_000 };
    Object.assign(state, { status: "pairing", username: me.username, error: null });
    // A deep link proves ownership of the local setup session; no public /start
    // message or first stranger can claim the diary.
    const deepLink = `https://t.me/${me.username}?start=${challenge}`;
    poll(pending, token, me).catch(error => {
      if (!stopped && error.name !== "AbortError")
        Object.assign(state, { status: "error", error: error.message });
    });
    return { url: deepLink, username: me.username };
  }
  async function poll(session, token, me) {
    let offset = 0;
    try {
      while (!stopped && pending === session && Date.now() < session.expires) {
        const updates = await session.api.call("getUpdates", { offset, timeout: 10,
          allowed_updates: ["message"] }, session.abort.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const m = update.message;
          if (m?.chat?.type !== "private" || m.from?.is_bot ||
              String(m.chat.id) !== String(m.from?.id) ||
              m.text !== `/start ${session.challenge}`) continue;
          const values = { TELEGRAM_BOT_TOKEN: token,
            TELEGRAM_OWNER_ID: String(m.from.id), TELEGRAM_BOT_USERNAME: me.username };
          await persist(values);
          Object.assign(process.env, values);
          store?.setSetting("telegram_offset", offset);
          await session.api.send(m.chat.id, "RUNLOG подключён.\n/run — начать пробежку\n/finish — закончить\n/log 3,2 24:30 — добавить результат\n/help — все команды").catch(() => {});
          pending = null;
          start();
          return;
        }
      }
      if (!stopped) Object.assign(state, { status: "disconnected", error: "Время подключения истекло. Повтори подключение." });
    } finally {
      if (pending === session) pending = null;
    }
  }
  async function stop() {
    stopped = true;
    pending?.abort.abort();
    pending = null;
    controller?.abort();
    await task;
  }
  return { state, start, pair, stop };
}
