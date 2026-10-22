import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseActivityImport, activityReport } from "../activity.mjs";
import { createStore } from "../store.mjs";
import { createHealthSync } from "../sync.mjs";
import { runAgent } from "../agent.mjs";
import { createBotHandler } from "../telegram.mjs";
import { parseWorkoutImport } from "../imports.mjs";

const clock = new Date("2026-10-23T18:00:00+07:00");
const sample = (day, value, extra = {}) => ({
  start: `2026-10-${day}T12:00:00+07:00`,
  end: `2026-10-${day}T12:10:00+07:00`,
  value,
  unit: "count",
  source: "iPhone",
  ...extra,
});
const payload = (extra = {}) =>
  JSON.stringify({
    format: "runlog-health-v1",
    generatedAt: "2026-10-23T17:00:00+07:00",
    steps: [sample(15, 100), sample(22, 500), sample(23, 300)],
    distance: [],
    ...extra,
  });
const parse = (text) => parseActivityImport(text, { now: clock });
async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runlog-health-"));
  const store = await createStore(dir);
  try {
    await run(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("Health import normalizes units, deduplicates identical samples and chooses one iPhone source", () => {
  const s = sample(23, 300);
  const result = parse(
    payload({
      steps: [s, s, sample(23, 10000, { source: "Other app" })],
      distance: [sample(23, "1,25", { unit: "км" })],
    }),
  );
  assert.equal(result.rows[0].steps, 300);
  assert.equal(result.rows[0].distanceKm, 1.25);
  assert.equal(result.rows[0].sampleCount, 2);
  assert.throws(
    () => parse(payload({ distance: [sample(23, 3, { unit: "unknown" })] })),
    /единица/,
  );
});
test("ambiguous sources, conflicting intervals, invalid dates and empty permissions are rejected", () => {
  assert.throws(
    () =>
      parse(
        payload({
          steps: [
            sample(23, 1, { source: "Device A" }),
            sample(23, 2, { source: "Device B" }),
          ],
        }),
      ),
    /источник/,
  );
  assert.throws(
    () => parse(payload({ steps: [sample(23, 1), sample(23, 2)] })),
    /конфликтующие/,
  );
  assert.throws(() => parse(payload({ steps: [sample(23, -2)] })), /диапазона/);
  assert.throws(() =>
    parse(
      payload({
        steps: [sample(23, 2, { start: "2026-02-30T12:00:00+07:00" })],
      }),
    ),
  );
  assert.throws(
    () => parse(payload({ steps: [], distance: [] })),
    /Пустой экспорт/,
  );
});
test("snapshots replace totals, survive restart, reject older data and preserve full historical days", async () =>
  withStore(async (store) => {
    const batch = parse(payload());
    assert.equal(store.importActivity(batch).days, 2); // the first rolling-window date is incomplete
    assert.equal(store.importActivity(batch).changed, false);
    assert.deepEqual(
      store.listActivity().map((r) => r.steps),
      [300, 500],
    );
    store.importActivity(
      parseActivityImport(
        payload({
          generatedAt: "2026-10-30T17:30:00+07:00",
          steps: [sample(22, 10), sample(23, 450)],
        }),
        { now: new Date("2026-10-30T18:00:00+07:00") },
      ),
    );
    assert.deepEqual(
      store.listActivity().map((r) => r.steps),
      [450, 500],
    );
    store.importActivity(batch);
    assert.deepEqual(
      store.listActivity().map((r) => r.steps),
      [450, 500],
    );
    assert.throws(
      () => store.importActivity({ ...batch, source: "Another iPhone" }),
      /Источник/,
    );
    const report = activityReport(store.listActivity(), {
      today: "2026-10-30",
      days: 30,
    });
    assert.equal(report.metrics.totalSteps, 950);
    assert.equal(report.metrics.recordedDays, 2);
    assert.match(report.reply, /Дни без данных/);
  }));
test("file watcher retries partial writes and does not re-add an identical export", async () =>
  withStore(async (store, dir) => {
    const file = path.join(dir, "runlog-health.json"),
      sync = createHealthSync({ store, file, now: () => clock });
    await sync.scan();
    assert.equal(sync.state.status, "waiting");
    await writeFile(file, '{"format":');
    await sync.scan();
    assert.equal(sync.state.status, "error");
    await writeFile(file, payload());
    await sync.scan();
    assert.equal(sync.state.status, "synced");
    assert.equal(store.listActivity().length, 2);
    await sync.scan();
    assert.equal(store.listActivity().length, 2);
    await sync.stop();
  }));
test("agent cannot replace a calculated report with invented progress claims", async () => {
  let call = 0;
  const result = await runAgent({
    text: "Мои шаги",
    today: "2026-10-23",
    store: { listActivity: () => parse(payload()).rows },
    model: async () =>
      call++
        ? { action: "respond", reply: "90000 шагов, форма улучшилась на 50%!" }
        : { action: "get_activity", periodDays: 7, reply: "" },
  });
  assert.equal(result.evidence.verified, true);
  assert.doesNotMatch(result.reply, /90000|50%/);
  assert.match(result.reply, /800/);
});
test("draft approval is owner-scoped and idempotent; outsiders cannot use the bot", async () =>
  withStore(async (store, dir) => {
    const draft = store.createDraft("123", {
      kind: "workout",
      workout: {
        date: "2026-10-23",
        sport: "run",
        distanceKm: 3,
        durationSeconds: 1200,
      },
    });
    assert.throws(() => store.confirmDraft(draft.id, "999"), /не найден/);
    const first = store.confirmDraft(draft.id, "123");
    const second = store.confirmDraft(draft.id, "123");
    assert.equal(first.id, second.id);
    assert.equal(second.alreadySaved, true);
    assert.equal(store.listWorkouts().length, 1);
    const sent = [];
    const handle = createBotHandler({
      api: { send: async (...args) => sent.push(args) },
      store,
      ownerId: "123",
      directory: dir,
    });
    await handle({
      update_id: 1,
      message: {
        from: { id: 999 },
        chat: { id: 999, type: "private" },
        text: "/export",
      },
    });
    assert.equal(sent.length, 0);
    const update = {
      update_id: 2,
      message: {
        from: { id: 123 },
        chat: { id: 123, type: "private" },
        text: "/history",
      },
    };
    await handle(update);
    await handle(update);
    assert.equal(sent.length, 1);
  }));
test("Apple workout XML imports convert units and reject external entities", () => {
  const xml =
    '<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2026-10-22 12:00:00 +0700" duration="20" durationUnit="min" totalDistance="3000" totalDistanceUnit="m"/></HealthData>';
  const parsed = parseWorkoutImport(xml, "export.xml");
  assert.equal(parsed.workouts[0].distanceKm, 3);
  assert.equal(parsed.workouts[0].durationSeconds, 1200);
  assert.throws(() =>
    parseWorkoutImport(
      '<!DOCTYPE foo SYSTEM "file:///etc/passwd"><foo/>',
      "export.xml",
    ),
  );
});

test("both standard iCloud locations can be watched without scanning other files", async () =>
  withStore(async (store, dir) => {
    const first = path.join(dir, "not-yet-synced.json"),
      second = path.join(dir, "runlog-health.json");
    await writeFile(second, payload());
    const sync = createHealthSync({
      store,
      file: [first, second],
      now: () => clock,
    });
    await sync.scan();
    assert.equal(sync.state.status, "synced");
    assert.equal(store.listActivity().length, 2);
    await sync.stop();
  }));
