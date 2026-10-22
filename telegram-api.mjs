export class TelegramAPI {
  constructor(token, transport = fetch) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || ""))
      throw new Error("Проверь токен Telegram-бота.");
    this.token = token;
    this.transport = transport;
  }
  async call(method, body = {}, signal) {
    try {
      const response = await this.transport(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(40000)])
            : AbortSignal.timeout(40000),
        },
      );
      const result = await response.json();
      if (!result.ok)
        throw new Error(`Telegram API ${result.error_code || response.status}`);
      return result.result;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error(
        /^Telegram API \d+$/.test(e.message)
          ? e.message
          : "Не удалось связаться с Telegram.",
      );
    }
  }
  async send(chatId, text, reply_markup) {
    const parts = Array.from(String(text));
    let sent;
    for (let i = 0; i < parts.length; i += 3500)
      sent = await this.call("sendMessage", {
        chat_id: chatId,
        text: parts.slice(i, i + 3500).join(""),
        ...(i + 3500 >= parts.length && reply_markup ? { reply_markup } : {}),
      });
    return sent;
  }
  async download(fileId) {
    const meta = await this.call("getFile", { file_id: fileId });
    if (
      !meta.file_path ||
      meta.file_path.includes("..") ||
      !/^[a-zA-Z0-9_./-]+$/.test(meta.file_path)
    )
      throw new Error("Некорректный путь файла Telegram.");
    if (meta.file_size > 8 * 1024 * 1024)
      throw new Error("Максимальный размер файла — 8 МБ.");
    try {
      const response = await this.transport(
        `https://api.telegram.org/file/bot${this.token}/${meta.file_path}`,
        { signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok) throw new Error("download");
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("large");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    } catch {
      throw new Error(
        "Не удалось получить файл. Поддерживаются файлы до 8 МБ.",
      );
    }
  }
  async sendFile(chatId, bytes, filename, mime = "application/json", caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("document", new Blob([bytes], { type: mime }), filename);
    try {
      const response = await this.transport(
        `https://api.telegram.org/bot${this.token}/sendDocument`,
        { method: "POST", body: form, signal: AbortSignal.timeout(40000) },
      );
      const result = await response.json();
      if (!result.ok) throw new Error("send");
      return result.result;
    } catch {
      throw new Error("Не удалось отправить файл.");
    }
  }
}
