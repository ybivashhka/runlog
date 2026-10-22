import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateWorkout, summarize, dateOnly, imageBuffer } from "../core.mjs";
import { createStore } from "../store.mjs";
import { runAgent } from "../agent.mjs";
import { createApp } from "../server.mjs";

const workout = {
  date: "2026-10-22",
  sport: "run",
  distanceKm: 3,
  durationSeconds: 1440,
  avgHR: 148,
  notes: "",
};

test("rejects impossible dates, invalid numbers and empty records", () => {
  assert.throws(() => dateOnly("2026-02-30"));
  assert.throws(() => validateWorkout({ ...workout, avgHR: 900 }));
  assert.throws(() => validateWorkout({ ...workout, distanceKm: -2 }));
  assert.throws(() =>
    validateWorkout({ ...workout, distanceKm: null, durationSeconds: null }),
  );
  assert.equal(
    validateWorkout({ ...workout, distanceKm: "3,2" }).distanceKm,
    3.2,
  );
});

test("pace is weighted by distance; walking and missing durations are excluded", () => {
  const stats = summarize([
    { ...workout, distanceKm: 1, durationSeconds: 300 },
    { ...workout, distanceKm: 4, durationSeconds: 2400 },
    { ...workout, distanceKm: 5, durationSeconds: null },
    { ...workout, sport: "walk", distanceKm: 50, durationSeconds: 10000 },
  ]);
  assert.equal(stats.totalKm, 10);
  assert.equal(stats.averagePaceSeconds, 540);
  assert.equal(summarize([]).averagePaceSeconds, null);
});

test("store persists data, blocks repeated screenshot and removes orphaned images", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runlog-store-"));
  let store;
  try {
    store = await createStore(directory);
    const buffer = await readFile(
      new URL("./fixtures/workout.png", import.meta.url),
    );
    const image = await store.saveImage(
      `data:image/png;base64,${buffer.toString("base64")}`,
    );
    const again = await store.saveImage(
      `data:image/png;base64,${buffer.toString("base64")}`,
    );
    assert.equal(image.id, again.id);
    const saved = store.saveWorkout({ ...workout, imageId: image.id });
    assert.throws(
      () => store.saveWorkout({ ...workout, imageId: image.id }),
      /уже сохранена/,
    );
    assert.throws(() => store.saveWorkout(workout), /Похожая/);
    store.close();
    store = await createStore(directory);
    assert.equal(store.listWorkouts().length, 1);
    await store.remove("workout", saved.id);
    assert.equal(store.getImage(image.id), undefined);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects disguised uploads", () =>
  assert.throws(() =>
    imageBuffer(
      `data:image/png;base64,${Buffer.from("<script>bad</script>").toString("base64")}`,
    ),
  ));

test("photos store measured weight and preserve an image while a workout still uses it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runlog-photos-"));
  const store = await createStore(directory);
  try {
    const buffer = await readFile(
      new URL("./fixtures/workout.png", import.meta.url),
    );
    const image = await store.saveImage(
      `data:image/png;base64,${buffer.toString("base64")}`,
    );
    assert.throws(() =>
      store.savePhoto({ imageId: image.id, date: "2026-10-22", weightKg: -1 }),
    );
    const photo = store.savePhoto({
      imageId: image.id,
      date: "2026-10-22",
      weightKg: 70,
      notes: "Тест",
    });
    const saved = store.saveWorkout({ ...workout, imageId: image.id });
    assert.equal(store.listPhotos()[0].weightKg, 70);
    await store.remove("photo", photo.id);
    assert.ok(store.getImage(image.id));
    await store.remove("workout", saved.id);
    assert.equal(store.getImage(image.id), undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent chooses tool, observes computed result, then replies", async () => {
  let step = 0;
  const result = await runAgent({
    text: "Как меняется бег?",
    today: "2026-10-22",
    store: { listWorkouts: () => [workout] },
    model: async ({ prompt }) => {
      if (step++ === 0)
        return { action: "get_progress", reply: "", workout: null };
      assert.match(prompt, /"totalKm":3/);
      assert.match(prompt, /"averagePaceSeconds":480/);
      return {
        action: "respond",
        reply: "Сохранена одна пробежка; для динамики нужны другие записи.",
        workout: null,
      };
    },
  });
  assert.equal(result.trace.filter((t) => t.type === "tool").length, 1);
  assert.equal(step, 2);
  assert.equal(result.draft, null);
});

test("draft is not written before user approval; missing values remain missing", async () => {
  const result = await runAgent({
    text: "Пробежал 3 км",
    store: { saveWorkout: () => assert.fail("Must not save") },
    model: async () => ({
      action: "propose_workout",
      reply: "Укажи дату и проверь поля.",
      workout: {
        ...workout,
        date: null,
        durationSeconds: null,
        avgHR: null,
        warnings: ["Дата не указана"],
      },
    }),
  });
  assert.equal(result.draft.date, null);
  assert.equal(result.draft.avgHR, null);
  assert.equal(result.trace.at(-1).type, "approval");
});

test("unavailable tools and repeated tool loops are stopped", async () => {
  await assert.rejects(
    runAgent({
      store: { listWorkouts: () => [] },
      model: async () => ({ action: "delete_history", reply: "" }),
    }),
    /неподдерживаемое/,
  );
  await assert.rejects(
    runAgent({
      store: { listWorkouts: () => [] },
      model: async () => ({ action: "get_progress", reply: "" }),
    }),
    /повторил/,
  );
});

test("HTTP requires token and correct origin; invalid data does not reach the database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runlog-http-"));
  const { server, store } = await createApp({ dataDir: directory });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/workouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workout),
    });
    assert.equal(denied.status, 403);
    const { token } = await (await fetch(`${base}/api/status`)).json();
    const headers = {
      "Content-Type": "application/json",
      "X-Diary-Token": token,
    };
    assert.equal(
      (
        await fetch(`${base}/api/workouts`, {
          method: "POST",
          headers: { ...headers, Origin: "https://unrelated.example" },
          body: JSON.stringify(workout),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/workouts`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...workout, date: "2026-02-30" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/workouts`, {
          method: "POST",
          headers,
          body: JSON.stringify(workout),
        })
      ).status,
      201,
    );
    const diary = await (await fetch(`${base}/api/diary`)).json();
    assert.equal(diary.workouts.length, 1);
    assert.equal(diary.summary.totalKm, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
