import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramAPI } from "./telegram-api.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
async function question(prompt, secret = false) {
  process.stdout.write(prompt);
  const sink = secret
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : process.stdout;
  const rl = createInterface({
    input: process.stdin,
    output: sink,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    return await new Promise((resolve) =>
      rl.question("", (answer) => resolve(answer.trim())),
    );
  } finally {
    rl.close();
    if (secret) process.stdout.write("\n");
  }
}
export async function setupTelegram() {
  console.log(
    "Настройка личного Telegram-бота RUNLOG. Токен сохранится только в локальном .env.",
  );
  const token = await question(
    "Вставь токен от @BotFather (ввод скрыт): ",
    true,
  );
  const api = new TelegramAPI(token),
    me = await api.call("getMe"),
    hook = await api.call("getWebhookInfo");
  if (hook.url)
    throw new Error(
      "У этого бота уже есть webhook. Создай отдельного бота для RUNLOG.",
    );
  console.log(
    `Бот: @${me.username}. Открой https://t.me/${me.username} на телефоне и отправь /start.`,
  );
  console.log("Ожидаю сообщение. Для отмены — Ctrl+C.");
  const deadline = Date.now() + 5 * 60 * 1000;
  let selected = null;
  while (Date.now() < deadline && !selected) {
    const updates = await api.call("getUpdates", {
      timeout: 20,
      allowed_updates: ["message"],
    });
    const candidates = updates.filter(
      (u) =>
        u.message?.chat?.type === "private" &&
        /^\/start(?:@\w+)?(?:\s|$)/.test(u.message?.text || ""),
    );
    const unique = [
      ...new Map(
        candidates.map((u) => [u.message.from.id, u.message]),
      ).values(),
    ];
    for (const m of unique) {
      const answer = await question(
        `Разрешить доступ ${m.from.username ? "@" + m.from.username : m.from.first_name} (ID ${m.from.id})? [y/N]: `,
      );
      if (/^(y|yes|да)$/i.test(answer)) {
        selected = m.from;
        break;
      }
    }
    if (!selected && unique.length)
      throw new Error("Доступ не подтверждён. Настройки не сохранены.");
  }
  if (!selected)
    throw new Error(
      "Сообщение /start не получено за 5 минут. Повтори настройку.",
    );
  const envPath = path.join(root, ".env");
  let old = "";
  try {
    old = await readFile(envPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const values = {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_OWNER_ID: String(selected.id),
    TELEGRAM_BOT_USERNAME: me.username,
  };
  const retained = old
    .split(/\r?\n/)
    .filter(
      (line) => !/^TELEGRAM_(BOT_TOKEN|OWNER_ID|BOT_USERNAME)=/.test(line),
    );
  const next =
    [
      ...retained,
      ...Object.entries(values).map(
        ([key, value]) => `${key}=${JSON.stringify(value)}`,
      ),
    ]
      .join("\n")
      .replace(/^\n+/, "") + "\n";
  await writeFile(envPath, next, { mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log(
    "Готово. Перезапусти npm start: дневник и бот запустятся вместе. Доступ разрешён только выбранному Telegram-аккаунту.",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  setupTelegram().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
