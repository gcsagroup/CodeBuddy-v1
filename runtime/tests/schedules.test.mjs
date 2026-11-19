import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../store.mjs";
import { ScheduleService } from "../schedules.mjs";
import * as schemas from "../../ui/sdk/dist/generated/zod.gen.js";

const recipe = {
  version: "1.0.0",
  title: "Verify project",
  description: "Run project verification",
  prompt: "Read the project and run its tests.",
};
const prefix = "_goose/unstable/schedules/";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("chat follow-ups validate their target, skip a busy occurrence and stop on chat deletion", async (t) => {
  let busy = false;
  const { call, scheduler, store, setTime, runs } = await fixture(t, {
    isSessionBusy: () => busy,
    sessionInfo: async (id) => (id === "chat" ? { sessionId: id } : null),
    run: async (_job, { onSession }) => {
      await onSession("chat");
      return { status: "completed", sessionId: "chat" };
    },
  });
  const input = {
    id: "follow",
    recipe,
    cron: "* * * * *",
    executionMode: "current_session",
    targetSessionId: "chat",
  };
  await assert.rejects(
    call("create", { ...input, targetSessionId: "missing" }),
    /target chat/i,
  );
  await assert.rejects(
    call("create", {
      ...input,
      recipe: { ...recipe, settings: { goose_model: "other" } },
    }),
    /existing model/,
  );
  const created = schemas.zCreateScheduleResponse_unstable.parse(
    await call("create", input),
  );
  assert.equal(created.job.targetSessionId, "chat");
  assert.equal(created.job.executionMode, "current_session");
  await call("run-now", { scheduleId: input.id });
  await call("unpause", { scheduleId: input.id });
  busy = true;
  await assert.rejects(call("run-now", { scheduleId: input.id }), /busy/);
  setTime("2026-10-14T02:01:00.000Z");
  assert.deepEqual(await scheduler.tick(), []);
  assert.equal(store.read().schedules[0].attempts.at(-1).reason, "target_busy");
  assert.equal(store.read().schedules[0].paused, false);
  assert.equal(store.read().schedules[0].nextRun, "2026-10-14T02:02:00.000Z");
  busy = false;
  await scheduler.stopSessionSchedules("chat");
  assert.equal(store.read().schedules[0].paused, true);
  assert.equal(store.read().schedules[0].tested, false);
  assert.match((await call("list")).jobs[0].lastError, /deleted/);
  assert.equal(runs(), 0);
});

test("follow-ups reserve their target during admission and cancel only their owned execution", async (t) => {
  const started = deferred();
  let stops = 0;
  const { call, scheduler } = await fixture(t, {
    stop: async () => { stops++; },
    run: async (_job, { onSession, signal }) => {
      await onSession('shared-chat');
      started.resolve();
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { status: 'cancelled', sessionId: 'shared-chat' };
    },
  });
  for (const id of ['first', 'second']) await call('create', { id, recipe, cron: '* * * * *',
    executionMode: 'current_session', targetSessionId: 'shared-chat' });
  const active = scheduler.beginRun('first');
  await started.promise;
  await assert.rejects(call('run-now', { scheduleId: 'second' }), /busy/);
  await call('running-job/kill', { jobId: 'first' });
  await (await active).done;
  assert.equal(stops, 0, 'a shared chat must not receive a session-wide stop');
});

test("a follow-up cannot report completion in a replacement chat", async (t) => {
  const { call, store } = await fixture(t);
  await call("create", {
    id: "bound",
    recipe,
    cron: "* * * * *",
    executionMode: "current_session",
    targetSessionId: "original",
  });
  await assert.rejects(call("run-now", { scheduleId: "bound" }), /bound chat/);
  assert.equal(store.read().schedules[0].tested, false);
});

test('shutdown cancels a running schedule, persists interruption and rejects subsequent starts', async t => {
  const entered = deferred();
  const { call, scheduler, store } = await fixture(t, { async run(_job, { signal, onSession }) {
    await onSession('update-cancelled-run');
    entered.resolve();
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'cancelled', sessionId: 'update-cancelled-run' };
  } });
  await call('create', { id: 'update-job', recipe, cron: '* * * * *' });
  const running = call('run-now', { scheduleId: 'update-job' });
  await entered.promise;
  await scheduler.close();
  await running;
  await assert.rejects(call('run-now', { scheduleId: 'update-job' }), /closed/);
  const row = store.read().schedules[0];
  assert.equal(row.lastOutcome, 'cancelled');
  assert.equal(row.currentlyRunning, false);
  assert.equal(row.paused, true);
  assert.equal(row.attempts.at(-1).status, 'cancelled');
});

async function fixture(t, options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-schedules-")),
  );
  const store = await openStore(path.join(root, "data"));
  let timestamp = Date.parse("2026-10-14T02:00:00.000Z");
  let runs = 0;
  const scheduler = new ScheduleService(store, {
    now: () => timestamp,
    timers: false,
    timeZone: "Asia/Shanghai",
    async run(job, { onSession }) {
      const sessionId = `session-${++runs}`;
      await onSession(sessionId);
      return { status: "completed", sessionId };
    },
    async sessionInfo(sessionId) {
      return {
        sessionId,
        cwd: root,
        title: sessionId,
        updatedAt: new Date(timestamp).toISOString(),
      };
    },
    getRecipe: async () => recipe,
    ...options,
  });
  await scheduler.start();
  t.after(async () => {
    await scheduler.close();
    await store.flush();
    assert.ok(path.basename(root).startsWith("codebuddy-schedules-"));
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    scheduler,
    call: (action, input = {}) => scheduler.request(prefix + action, input),
    setTime: (value) => {
      timestamp = Date.parse(value);
    },
    runs: () => runs,
  };
}

test("update waits for admitted schedule startup and refuses to interrupt its run", async (t) => {
  const entered = deferred(), releaseWrite = deferred(), releaseRun = deferred();
  const { call, store, scheduler } = await fixture(t, {
    async run() { await releaseRun.promise; return { status: "cancelled" }; },
  });
  await call("create", { id: "upgrade-race", recipe, cron: "0 * * * *" });
  const update = store.update.bind(store);
  store.update = async (...args) => { entered.resolve(); await releaseWrite.promise; return update(...args); };
  const starting = scheduler.beginRun("upgrade-race");
  await entered.promise;
  let reserved = false;
  const closing = scheduler.reserveShutdownIfIdle(() => { reserved = true; return true; });
  releaseWrite.resolve();
  const active = await starting;
  assert.equal(await closing, false);
  assert.equal(reserved, false);
  assert.equal(active.controller.signal.aborted, false);
  releaseRun.resolve();
  await active.done;
  assert.equal(await scheduler.reserveShutdownIfIdle(() => false), false);
  assert.equal(scheduler.closed, false);
  assert.equal(await scheduler.reserveShutdownIfIdle(() => true), true);
  await assert.rejects(scheduler.beginRun("upgrade-race"), /closed/);
});

test("scheduled recipes reject unconnected advanced fields before saving while preserving a real turn limit", async (t) => {
  const { call, store } = await fixture(t);
  for (const extra of [
    { retry: { max_retries: 2 } },
    { sub_recipes: [{ name: "child", path: "child.yaml" }] },
    { response: { json_schema: { type: "object" } } },
  ]) {
    await assert.rejects(
      call("create", {
        id: "unsupported",
        recipe: { ...recipe, ...extra },
        cron: "0 * * * *",
      }),
      (error) => error.data?.reason === "recipe_feature_not_connected",
    );
    assert.deepEqual((await call("list")).jobs, []);
  }
  await call("create", {
    id: "bounded",
    recipe: { ...recipe, settings: { max_turns: 11 } },
    cron: "0 * * * *",
  });
  assert.equal(store.read().schedules[0].recipe.settings.max_turns, 11);
});

test("schedule CRUD uses original DTOs and a real frozen recipe while enabling needs a completed run", async (t) => {
  const { call, store } = await fixture(t);
  const created = schemas.zCreateScheduleResponse_unstable.parse(
    await call("create", {
      id: "Project tests",
      recipe,
      cron: "0 0 14 * * *",
      tested: true,
    }),
  );
  assert.equal(created.job.paused, true);
  assert.equal(created.job.tested, false);
  assert.match(
    await readFile(created.job.source, "utf8"),
    /Run project verification/u,
  );
  assert.equal(store.read().schedules[0].nextRun, "2026-10-14T06:00:00.000Z");
  await assert.rejects(
    call("unpause", { scheduleId: created.job.id }),
    /successfully/u,
  );
  const result = schemas.zRunScheduleNowResponse_unstable.parse(
    await call("run-now", { scheduleId: created.job.id }),
  );
  assert.equal(result.status, "completed");
  assert.equal(store.read().schedules[0].tested, true);
  assert.equal(store.read().schedules[0].paused, true);
  await call("unpause", { scheduleId: created.job.id });
  assert.equal((await call("list")).jobs[0].paused, false);
  const sessions = schemas.zListScheduleSessionsResponse_unstable.parse(
    await call("sessions/list", { scheduleId: created.job.id, limit: 10 }),
  );
  assert.equal(sessions.sessions[0].sessionId, result.sessionId);
  assert.deepEqual(
    await call("sessions/list", { scheduleId: created.job.id, limit: 0 }),
    { sessions: [] },
  );
  const updated = schemas.zUpdateScheduleResponse_unstable.parse(
    await call("update", { scheduleId: created.job.id, cron: "0 0 16 * * *" }),
  );
  assert.equal(updated.job.cron, "0 0 16 * * *");
  assert.equal(store.read().schedules[0].nextRun, "2026-10-14T08:00:00.000Z");
  await call("pause", { scheduleId: created.job.id });
  schemas.zListSchedulesResponse_unstable.parse(await call("list"));
  await call("delete", { scheduleId: created.job.id });
  assert.deepEqual((await call("list")).jobs, []);
});

test("cron validation delegates to Harness and supports original literal-zero seconds picker format", async (t) => {
  const { call } = await fixture(t);
  await call("create", {
    id: "five",
    recipe,
    cron: "*/5 * * * *",
    paused: false,
  });
  assert.equal((await call("list")).jobs[0].paused, false);
  for (const cron of [
    "5 * * * * *",
    "0 * * * * * *",
    "* * *",
    "0 99 14 * * *",
    "0 0 0 31 2 *",
  ]) {
    await assert.rejects(
      call("create", { id: `invalid-${cron}`, recipe, cron }),
      /cron|occurrence/u,
    );
  }
  await assert.rejects(
    call("create", { id: "five", recipe, cron: "* * * * *" }),
    /already exists/u,
  );
  await assert.rejects(
    call("create", { id: "../escape", recipe, cron: "* * * * *" }),
    /separators/u,
  );
  await assert.rejects(
    call("create", {
      id: "parameter",
      recipe: {
        ...recipe,
        parameters: [
          {
            key: "name",
            description: "Name",
            input_type: "string",
            requirement: "required",
          },
        ],
      },
      cron: "* * * * *",
    }),
    /defaults/u,
  );
});

test("run-now is exclusive, inspection reflects persisted session and kill cancels the same run", async (t) => {
  const started = deferred();
  const stopped = [];
  const { call, store, setTime } = await fixture(t, {
    async run(job, { signal, onSession }) {
      await onSession("held-session");
      started.resolve();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      return { status: "cancelled", sessionId: "held-session" };
    },
    async stop(sessionId) {
      stopped.push(sessionId);
    },
  });
  await call("create", { id: "held", recipe, cron: "* * * * *" });
  const running = call("run-now", { scheduleId: "held" });
  await started.promise;
  await assert.rejects(
    call("run-now", { scheduleId: "held" }),
    /already running/u,
  );
  await assert.rejects(call("delete", { scheduleId: "held" }), /Stop/u);
  setTime("2026-10-14T02:00:03.900Z");
  const inspected = schemas.zInspectRunningJobResponse_unstable.parse(
    await call("running-job/inspect", { jobId: "held" }),
  );
  assert.equal(inspected.runningDurationSeconds, 3);
  assert.equal(inspected.sessionId, "held-session");
  schemas.zKillRunningJobResponse_unstable.parse(
    await call("running-job/kill", { jobId: "held" }),
  );
  assert.equal((await running).status, "cancelled");
  assert.deepEqual(stopped, ["held-session"]);
  const stored = store.read().schedules[0];
  assert.equal(stored.currentlyRunning, false);
  assert.equal(stored.paused, true);
  assert.equal(stored.tested, false);
  assert.equal(stored.attempts[0].status, "cancelled");
});

test("a restarted scheduler pauses interrupted or untested tasks without replaying missed occurrences", async (t) => {
  const { call, store, scheduler, setTime, runs } = await fixture(t);
  await call("create", { id: "interrupted", recipe, cron: "* * * * *" });
  await call("create", {
    id: "untested",
    recipe,
    cron: "* * * * *",
    paused: false,
  });
  await store.update((state) => {
    const row = state.schedules[0];
    row.currentlyRunning = true;
    row.paused = false;
    row.tested = true;
    row.currentSessionId = "old-session";
    row.attempts.push({ id: "old-attempt", status: "running" });
  });
  await scheduler.close();
  setTime("2026-10-15T02:00:00.000Z");
  const restarted = new ScheduleService(await openStore(store.directory), {
    now: () => Date.parse("2026-10-15T02:00:00.000Z"),
    timers: false,
    run: () => {
      throw new Error("A restart must not run this");
    },
  });
  await restarted.start();
  const jobs = (await restarted.request(prefix + "list")).jobs;
  assert.ok(
    jobs.every((job) => job.paused && !job.currentlyRunning && !job.tested),
  );
  assert.equal(restarted.rows()[0].lastOutcome, "interrupted");
  assert.equal(restarted.rows()[0].attempts[0].status, "interrupted");
  assert.equal(restarted.rows()[0].nextRun, "2026-10-15T02:01:00.000Z");
  assert.deepEqual(await restarted.tick(), []);
  assert.equal(runs(), 0);
  await restarted.close();
});

test("due ticks coalesce missed times and concurrent ticks do not create duplicate sessions", async (t) => {
  const { call, scheduler, store, setTime, runs } = await fixture(t);
  await call("create", { id: "recurring", recipe, cron: "* * * * *" });
  await call("run-now", { scheduleId: "recurring" });
  await call("unpause", { scheduleId: "recurring" });
  setTime("2026-10-14T02:30:00.000Z");
  const results = await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(results.flat().length, 1);
  await Promise.all([...scheduler.active.values()].map((entry) => entry.done));
  assert.equal(runs(), 2);
  assert.equal(store.read().schedules[0].nextRun, "2026-10-14T02:31:00.000Z");
  assert.deepEqual(await scheduler.tick(), []);
});

test("structured runner failures pause schedules and do not claim successful tests", async (t) => {
  const { call, store } = await fixture(t, {
    run: async () => "All done successfully",
  });
  await call("create", { id: "invalid-result", recipe, cron: "* * * * *" });
  await assert.rejects(
    call("run-now", { scheduleId: "invalid-result" }),
    /structured/u,
  );
  assert.equal(store.read().schedules[0].lastOutcome, "failed");
  assert.equal(store.read().schedules[0].tested, false);
  assert.equal(store.read().schedules[0].paused, true);
});

test("recipe schedule associations are paused, editable and removable through the original RPC", async (t) => {
  const { scheduler, store } = await fixture(t);
  const name = "_goose/unstable/recipes/schedule";
  await scheduler.request(name, {
    id: "recipe-id",
    cron_schedule: "0 0 14 * * *",
  });
  assert.equal(store.read().schedules[0].recipeId, "recipe-id");
  assert.equal(store.read().schedules[0].paused, true);
  await scheduler.request(name, {
    id: "recipe-id",
    cron_schedule: "0 0 16 * * *",
  });
  assert.equal(store.read().schedules.length, 1);
  assert.equal(store.read().schedules[0].cron, "0 0 16 * * *");
  await scheduler.request(name, { id: "recipe-id", cron_schedule: null });
  assert.deepEqual(store.read().schedules, []);
});

test("schedule extension credentials are protected at rest and restored only for execution", async (t) => {
  const runs = [];
  const { call, store } = await fixture(t, {
    async run(job, { onSession }) {
      runs.push(job);
      await onSession("protected-schedule-session");
      return { status: "completed", sessionId: "protected-schedule-session" };
    },
  });
  const secretMarker = "isolated-schedule-extension-token";
  const extension = {
    type: "stdio",
    name: "fixture-tool",
    cmd: "node",
    args: ["tool.mjs"],
    envs: { TOKEN: secretMarker },
  };
  const created = await call("create", {
    id: "protected-schedule",
    cron: "* * * * *",
    recipe: { ...recipe, extensions: [extension] },
  });
  const stateText = await readFile(
    path.join(store.directory, "state.json"),
    "utf8",
  );
  const sourceText = await readFile(created.job.source, "utf8");
  assert.ok(!stateText.includes(secretMarker));
  assert.ok(!sourceText.includes(secretMarker));
  assert.ok(stateText.includes(process.platform === "darwin" ? "macos-keychain-aesgcm-v1" : "windows-dpapi"));
  await call("run-now", { scheduleId: created.job.id });
  assert.equal(runs[0].recipe.extensions[0].envs.TOKEN, secretMarker);
  assert.equal(runs[0].protectedRecipeExtensions, undefined);
  assert.deepEqual(store.read().schedules[0].recipe.extensions, []);
});

test('weekday schedules skip the weekend and preserve recipe-local effort without accepting chat overrides', async (t) => {
  const { call, store, setTime } = await fixture(t);
  setTime('2026-10-16T02:00:00.000Z');
  await call('create', { id: 'weekday-task', cron: '0 0 9 * * 1-5', recipe: { ...recipe, settings: { goose_thinking_effort: 'high' } } });
  assert.equal(store.read().schedules[0].nextRun, '2026-10-19T01:00:00.000Z');
  assert.equal(store.read().schedules[0].recipe.settings.goose_thinking_effort, 'high');
  await call('create', { id: 'service-default', cron: '* * * * *', recipe: { ...recipe, settings: { goose_thinking_effort: 'default' } } });
  assert.equal(store.read().schedules.find(job => job.id === 'service-default').recipe.settings.goose_thinking_effort, 'default');
  await assert.rejects(call('create', { id: 'invalid-effort', cron: '* * * * *', recipe: { ...recipe, settings: { goose_thinking_effort: 'invented' } } }), /Invalid scheduled recipe/);
  await assert.rejects(call('create', { id: 'chat-override', cron: '* * * * *', executionMode: 'current_session', targetSessionId: 'chat', recipe: { ...recipe, settings: { goose_thinking_effort: 'high' } } }), /existing model and tools/);
});
