import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.dirname(fileURLToPath(import.meta.url));
export function dataDirectory(value = process.env.RUNLOG_DATA_DIR) {
  if (!value) return path.join(root, "data");
  // Older installers used JSON's ASCII escaping inside .env. Node does not
  // decode \uXXXX there, so it otherwise creates a second, empty diary.
  const decoded = value.replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return path.resolve(decoded);
}

export async function saveSettings(values, filename = path.join(root, ".env")) {
  let previous = "";
  try { previous = await readFile(filename, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(String(value)))
      throw new Error("Некорректная настройка.");
  }
  const keys = new Set(Object.keys(values));
  const lines = previous.split(/\r?\n/).filter(line =>
    !keys.has(line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]),
  );
  while (lines.at(-1) === "") lines.pop();
  const next = [...lines, ...Object.entries(values).map(([key, value]) =>
    `${key}=${JSON.stringify(String(value))}`,
  )].join("\n") + "\n";
  const { rename } = await import("node:fs/promises");
  const temp = `${filename}.${process.pid}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, filename);
}
