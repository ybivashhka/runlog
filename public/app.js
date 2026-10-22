const $ = (selector) => document.querySelector(selector);
const state = {
  token: "",
  today: "",
  diary: { workouts: [], photos: [], summary: {} },
  editingId: null,
  imageId: null,
  photoImageId: null,
  busy: false,
};
const labels = {
  run: "Бег",
  walk: "Ходьба",
  cycle: "Велосипед",
  strength: "Силовая",
  other: "Тренировка",
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (n) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
const date = (value) =>
  new Date(`${value}T12:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
const pace = (value) => {
  if (value == null) return "—";
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const duration = (value) =>
  value == null
    ? "—"
    : `${Math.floor(value / 60)}:${String(Math.round(value) % 60).padStart(2, "0")}`;

async function api(url, method = "GET", body) {
  const result = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Diary-Token": state.token,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || "Не удалось выполнить запрос.");
  return data;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 4000);
}
function empty(title, text) {
  return `<div class="empty"><span class="empty-symbol">↗</span><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`;
}
function setView(id) {
  document
    .querySelectorAll(".view")
    .forEach((el) => (el.hidden = el.id !== id));
  document
    .querySelectorAll(".nav")
    .forEach((el) => el.classList.toggle("active", el.dataset.view === id));
}
document
  .querySelectorAll(".nav")
  .forEach((button) =>
    button.addEventListener("click", () => setView(button.dataset.view)),
  );
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      document.getElementById(button.dataset.close).close(),
    ),
  );

async function refresh() {
  state.diary = await api("/api/diary");
  render();
}
function render() {
  const { workouts, photos, summary } = state.diary;
  renderActivity();
  $("#stat-count").textContent = workouts.length;
  $("#stat-km").innerHTML = `${fmt(summary.totalKm || 0)} <em>км</em>`;
  $("#stat-pace").innerHTML = summary.averagePaceSeconds
    ? `${pace(summary.averagePaceSeconds)} <em>/км</em>`
    : "—";
  const first = [...workouts].sort((a, b) => a.date.localeCompare(b.date))[0];
  $("#stat-first").textContent = first ? date(first.date) : "—";
  renderChart(summary.weeklyKm || []);
  $("#workout-list").innerHTML = workouts.length
    ? [...workouts]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(
          (w) =>
            `<div class="workout-row"><span class="sport-icon">${w.sport === "run" ? "↗" : "◉"}</span><div class="workout-main"><strong>${esc(labels[w.sport])} · ${esc(date(w.date))}</strong><p>${esc(w.notes || (w.avgHR ? `Средний пульс ${w.avgHR} уд/мин` : ""))}</p></div><div class="workout-numbers">${w.distanceKm ? `${fmt(w.distanceKm)} км` : duration(w.durationSeconds)}<small>${w.distanceKm && w.durationSeconds ? `${pace(w.durationSeconds / w.distanceKm)} /км · ` : ""}${w.durationSeconds ? duration(w.durationSeconds) : "Время не указано"}</small></div><button class="text-button" data-edit-workout="${esc(w.id)}" aria-label="Изменить тренировку">✎</button><button class="delete-button" data-delete-workout="${esc(w.id)}" aria-label="Удалить тренировку">×</button></div>`,
        )
        .join("")
    : empty(
        "Тренировок пока нет",
        "Добавь занятие вручную, через Telegram или импорт из файла.",
      );
  document.querySelectorAll("[data-delete-workout]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm("Удалить эту тренировку?")) return;
      try {
        await api(`/api/workout/${button.dataset.deleteWorkout}`, "DELETE");
        await refresh();
        toast("Тренировка удалена");
      } catch (e) {
        toast(e.message);
      }
    }),
  );
  $("#photo-gallery").innerHTML = photos.length
    ? photos
        .map(
          (p) =>
            `<article class="photo-card"><img src="/images/${esc(p.imageId)}" alt="Фото формы от ${esc(date(p.date))}" loading="lazy"><div class="photo-info"><div><strong>${esc(date(p.date))}${p.weightKg ? ` · ${fmt(p.weightKg)} кг` : ""}</strong><p>${esc(p.notes || "")}</p></div><button class="delete-button" data-delete-photo="${esc(p.id)}" aria-label="Удалить фото">×</button></div></article>`,
        )
        .join("")
    : empty(
        "Фотографий пока нет",
        "Добавь фото, чтобы позже сравнить снимки по датам.",
      );
  document.querySelectorAll("[data-delete-photo]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm("Удалить фото и запись из дневника?")) return;
      try {
        await api(`/api/photo/${button.dataset.deletePhoto}`, "DELETE");
        await refresh();
      } catch (e) {
        toast(e.message);
      }
    }),
  );
}
function renderChart(weeks) {
  if (!weeks.length) {
    $("#chart").innerHTML = empty(
      "Нет данных для графика",
      "График строится по сохранённым пробежкам.",
    );
    return;
  }
  const first = new Date(`${weeks[0].week}T12:00:00Z`),
    last = new Date(`${weeks.at(-1).week}T12:00:00Z`),
    values = new Map(weeks.map((w) => [w.week, w.km]));
  const series = [];
  // Не больше последних 16 недель: пропущенная неделя остаётся нулевой, а не исчезает.
  const start = new Date(
    Math.max(first.getTime(), last.getTime() - 15 * 7 * 86400000),
  );
  for (const d = new Date(start); d <= last; d.setUTCDate(d.getUTCDate() + 7)) {
    const week = d.toISOString().slice(0, 10);
    series.push({ week, km: values.get(week) || 0 });
  }
  const max = Math.max(1, ...series.map((s) => s.km)),
    width = 580,
    height = 205,
    x0 = 34,
    y0 = 170,
    plotW = 525,
    plotH = 140;
  const gap = plotW / series.length,
    barW = Math.min(65, gap * 0.5);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Километры бега по неделям">`;
  for (let i = 0; i <= 3; i++) {
    const y = y0 - (plotH * i) / 3;
    svg += `<line x1="${x0}" y1="${y}" x2="565" y2="${y}" stroke="#e6e9dd" stroke-dasharray="3 4"/><text x="25" y="${y + 3}" text-anchor="end" font-size="9" fill="#8c967e">${fmt((max * i) / 3)}</text>`;
  }
  series.forEach((s, i) => {
    const x = x0 + gap * i + (gap - barW) / 2,
      h = (s.km / max) * plotH;
    svg += `<rect x="${x}" y="${y0 - h}" width="${barW}" height="${Math.max(h, 1)}" rx="4" fill="${i === series.length - 1 ? "#819d60" : "#d3dfbd"}"><title>${esc(date(s.week))}: ${fmt(s.km)} км</title></rect><text x="${x + barW / 2}" y="${y0 + 20}" text-anchor="middle" font-size="9" fill="#879378">${esc(date(s.week))}</text>`;
  });
  $("#chart").innerHTML = svg + "</svg>";
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || file.size > 8 * 1024 * 1024)
      return reject(new Error("Выбери изображение до 8 МБ."));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать фото."));
    reader.readAsDataURL(file);
  });
}
async function upload(file) {
  const dataUrl = await readFile(file);
  return (await api("/api/images", "POST", { dataUrl })).id;
}
function setTrace(trace) {
  $("#agent-trace").innerHTML = trace
    .map(
      (t) =>
        `<li>${esc(t.label)}${t.name ? `<br><code>${esc(t.name)}</code>` : ""}</li>`,
    )
    .join("");
  $("#trace-count").textContent = `${trace.length} шагов`;
}
function message(text, role = "agent") {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  $("#agent-messages").append(div);
  div.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
async function ask(text, imageId, statusElement) {
  if (state.busy) throw new Error("Дождись предыдущего ответа.");
  state.busy = true;
  $("#chat-send").disabled = true;
  $("#recognize").disabled = true;
  try {
    const { id } = await api("/api/agent", "POST", { text, imageId });
    while (true) {
      const job = await api(`/api/jobs/${id}`);
      setTrace(job.trace);
      if (statusElement) {
        statusElement.className = "status-note";
        statusElement.textContent =
          job.trace.at(-1)?.label || "Запускаем Codex…";
      }
      if (job.status === "error") throw new Error(job.error);
      if (job.status === "done") return job.result;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  } finally {
    state.busy = false;
    $("#chat-send").disabled = false;
    $("#recognize").disabled = false;
  }
}

$("#add-workout").addEventListener("click", () => {
  state.editingId = null;
  $("#workout-form").reset();
  state.imageId = null;
  $("#w-date").value = state.today;
  $("#workout-preview").hidden = true;
  $("#workout-preview").removeAttribute("src");
  $("#workout-error").textContent = "";
  $("#recognition-status").textContent = "";
  $("#recognition-status").className = "";
  $("#workout-dialog").showModal();
});
$("#workout-image").addEventListener("change", async () => {
  try {
    const file = $("#workout-image").files[0];
    if (!file) return;
    if (state.imageId) await api(`/api/image/${state.imageId}`, "DELETE");
    state.imageId = null;
    $("#workout-preview").src = await readFile(file);
    $("#workout-preview").hidden = false;
  } catch (e) {
    $("#workout-error").textContent = e.message;
  }
});
$("#workout-dialog").addEventListener("close", () => {
  if (state.imageId) {
    api(`/api/image/${state.imageId}`, "DELETE").catch(() => {});
    state.imageId = null;
  }
});
function fillDraft(draft) {
  $("#w-date").value = draft.date || "";
  $("#w-sport").value = draft.sport;
  $("#w-distance").value = draft.distanceKm ?? "";
  $("#w-hr").value = draft.avgHR ?? "";
  $("#w-minutes").value =
    draft.durationSeconds == null ? "" : Math.floor(draft.durationSeconds / 60);
  $("#w-seconds").value =
    draft.durationSeconds == null ? "" : Math.round(draft.durationSeconds) % 60;
  $("#w-notes").value = draft.notes || "";
  if (draft.imageId) state.imageId = draft.imageId;
}
$("#recognize").addEventListener("click", async () => {
  $("#workout-error").textContent = "";
  try {
    const file = $("#workout-image").files[0],
      text = $("#workout-text").value.trim();
    if (!file && !text)
      throw new Error("Добавь снимок или описание тренировки.");
    if (file && !state.imageId) state.imageId = await upload(file);
    const result = await ask(text, state.imageId, $("#recognition-status"));
    $("#recognition-status").textContent =
      result.reply +
      (result.draft?.warnings?.length
        ? "\n\n" + result.draft.warnings.join("\n")
        : "") +
      (result.draft && !result.draft.date
        ? "\nУкажи дату: модель не нашла её в исходных данных."
        : "");
    if (result.draft) fillDraft(result.draft);
  } catch (e) {
    $("#workout-error").textContent = e.message;
  }
});
$("#workout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#workout-error").textContent = "";
  $("#save-workout").disabled = true;
  try {
    if (state.busy) throw new Error("Дождись распознавания перед сохранением.");
    const file = $("#workout-image").files[0];
    if (file && !state.imageId) state.imageId = await upload(file);
    const minutes = $("#w-minutes").value,
      seconds = $("#w-seconds").value;
    const durationSeconds =
      minutes === "" && seconds === ""
        ? null
        : Number(minutes || 0) * 60 + Number(seconds || 0);
    await api(
      state.editingId ? `/api/workouts/${state.editingId}` : "/api/workouts",
      state.editingId ? "PUT" : "POST",
      {
        date: $("#w-date").value,
        sport: $("#w-sport").value,
        distanceKm: $("#w-distance").value,
        durationSeconds,
        avgHR: $("#w-hr").value,
        notes: $("#w-notes").value,
        imageId: state.imageId,
      },
    );
    $("#workout-dialog").close();
    await refresh();
    toast("Тренировка сохранена");
  } catch (e) {
    $("#workout-error").textContent = e.message;
  } finally {
    $("#save-workout").disabled = false;
  }
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  message(text, "user");
  $("#chat-input").value = "";
  try {
    const result = await ask(text);
    message(result.reply);
    if (result.evidence)
      message(
        `Проверено по записям: ${result.evidence.sourceCount}. Расчёты выполнены приложением.`,
      );
    if (result.draft) {
      state.editingId = null;
      $("#workout-form").reset();
      state.imageId = null;
      $("#workout-preview").hidden = true;
      $("#workout-error").textContent = "";
      $("#recognition-status").textContent =
        result.draft.warnings?.join("\n") ||
        "Проверь показатели перед сохранением.";
      $("#recognition-status").className = "status-note";
      fillDraft(result.draft);
      $("#workout-dialog").showModal();
    }
  } catch (e) {
    message(e.message, "error");
  }
});
document.querySelectorAll("[data-question]").forEach((button) =>
  button.addEventListener("click", () => {
    $("#chat-input").value = button.dataset.question;
    $("#chat-form").requestSubmit();
  }),
);
$("#add-photo").addEventListener("click", () => {
  $("#photo-form").reset();
  $("#photo-date").value = state.today;
  $("#photo-error").textContent = "";
  state.photoImageId = null;
  $("#photo-dialog").showModal();
});
$("#photo-dialog").addEventListener("close", () => {
  if (state.photoImageId) {
    api(`/api/image/${state.photoImageId}`, "DELETE").catch(() => {});
    state.photoImageId = null;
  }
});
$("#photo-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button =
    $('#photo-form button[type="submit"]') || $("#photo-form .lime");
  button.disabled = true;
  try {
    if (!state.photoImageId)
      state.photoImageId = await upload($("#body-image").files[0]);
    await api("/api/photos", "POST", {
      imageId: state.photoImageId,
      date: $("#photo-date").value,
      weightKg: $("#photo-weight").value,
      notes: $("#photo-notes").value,
    });
    $("#photo-dialog").close();
    await refresh();
    toast("Фото сохранено локально");
  } catch (e) {
    $("#photo-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
});

try {
  const status = await api("/api/status");
  state.token = status.token;
  state.today = status.today;
  $("#today-label").textContent = new Date(`${state.today}T12:00:00`)
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
    .toUpperCase();
  $("#codex-status").textContent = status.codex.authenticated
    ? "Codex подключён"
    : status.codex.available
      ? "Нужен вход в Codex"
      : "Codex CLI не найден";
  $("#codex-status").classList.toggle("ready", status.codex.authenticated);
  if (status.telegramUsername) {
    const link = document.createElement("a");
    link.href = `https://t.me/${status.telegramUsername}`;
    link.textContent = `Открыть @${status.telegramUsername} ↗`;
    $("#telegram-connection").replaceChildren(link);
  }
  await refresh();
  setInterval(() => refresh().catch(() => {}), 15000);
} catch (e) {
  toast(e.message);
  $("#codex-status").textContent = "Не удалось подключиться";
}

function renderActivity() {
  const { activity = [], sync = {} } = state.diary;
  const labels = {
    synced: "Синхронизировано",
    waiting: "Ожидаем файл с iPhone",
    disabled: "Не подключено",
    error: "Ошибка синхронизации",
  };
  $("#sync-status").textContent =
    labels[sync.status] || "Ожидаем синхронизацию";
  const last = sync.lastImport;
  $("#sync-detail").textContent =
    sync.error ||
    (last
      ? `Источник: ${last.source} · Экспорт ${new Date(last.generatedAt).toLocaleString("ru-RU")}. Шаги и дистанция ходьбы и бега; учитываются отдельно от тренировок.`
      : "В разделе «Подключения» установи RUNLOG Health Sync на iPhone.");
  const rows = activity.slice(0, 7).reverse();
  $("#activity-days").innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<article><span>${esc(date(r.date))}${r.partial ? " · неполный день" : ""}</span><strong>${r.steps == null ? "—" : fmt(r.steps)}</strong><small>шагов${r.distanceKm == null ? "" : ` · ${fmt(r.distanceKm)} км`}</small></article>`,
        )
        .join("")
    : '<p class="caption">Данные активности ещё не поступили.</p>';
}
$("#workout-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-workout]");
  if (!button) return;
  const w = state.diary.workouts.find(
    (w) => w.id === button.dataset.editWorkout,
  );
  $("#workout-form").reset();
  state.editingId = w.id;
  state.imageId = null;
  $("#workout-preview").hidden = true;
  $("#recognition-status").textContent = "";
  $("#workout-error").textContent = "";
  fillDraft(w);
  $("#workout-dialog").showModal();
});
$("#import-file").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024)
      throw new Error("Размер импорта не должен превышать 8 МБ.");
    const draft = await api("/api/import", "POST", {
      filename: file.name,
      text: await file.text(),
    });
    if (
      !confirm(
        `Импортировать ${draft.count} тренировок? Некорректных: ${draft.skipped}. Дубли будут пропущены.`,
      )
    )
      return;
    const result = await api(`/api/imports/${draft.id}/confirm`, "POST", {});
    await refresh();
    toast(`Импортировано: ${result.imported}. Дубли: ${result.duplicates}.`);
  } catch (error) {
    toast(error.message);
  } finally {
    event.target.value = "";
  }
});
