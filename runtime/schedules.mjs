import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { protectSecret, revealSecret } from "./secrets.mjs";
import { zRecipeDto } from "../ui/sdk/dist/generated/zod.gen.js";
import { assertRecipeExecutable } from "./recipe-execution.mjs";
// Schedule helpers transitively import subagents; establish its native contract
// before that module graph is loaded, including the server's lazy driver path.
import "./harness/native-schedule-contract.mjs";
const { createCronScheduleRecord, parseCronInput } =
  await import("./harness/node_modules/@deepseek-ai/dsh-schedule/lib/index.js");

const require = createRequire(
  new URL("../ui/desktop/package.json", import.meta.url),
);
const YAML = require("yaml");
const prefix = "_goose/unstable/schedules/";
const actions = new Set([
  "list",
  "sessions/list",
  "create",
  "delete",
  "pause",
  "unpause",
  "update",
  "run-now",
  "running-job/kill",
  "running-job/inspect",
]);
const invalid = (message) =>
  Object.assign(new Error(message), { code: -32602 });
const digest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

function cronExpression(cron, timeZone) {
  if (typeof cron !== "string") throw invalid("A cron expression is required");
  const fields = cron.trim().split(/\s+/u);
  // The original picker emits seconds followed by the five standard fields.
  // Only its literal-zero seconds adapter is ours; parsing and calendar/DST
  // calculations remain the official Harness schedule implementation.
  if (fields.length === 6 && fields[0] === "0") fields.shift();
  if (fields.length !== 5)
    throw invalid(
      "This scheduler accepts five cron fields or six fields with seconds set to 0",
    );
  try {
    return parseCronInput({
      expression: fields.join(" "),
      time_zone: timeZone,
    });
  } catch (error) {
    throw invalid(`Invalid cron expression: ${error.message}`);
  }
}

function recipeValue(value) {
  const parsed = zRecipeDto.safeParse(value);
  if (!parsed.success)
    throw invalid(`Invalid scheduled recipe: ${parsed.error.message}`);
  assertRecipeExecutable(parsed.data);
  if (!parsed.data.prompt?.trim() && !parsed.data.instructions?.trim())
    throw invalid("A scheduled recipe needs a prompt or instructions");
  if (
    parsed.data.parameters?.some(
      (parameter) =>
        parameter.requirement !== "optional" && parameter.default == null,
    )
  ) {
    throw invalid("Automatic task parameters need defaults before scheduling");
  }
  return parsed.data;
}

export class ScheduleService {
  constructor(
    store,
    {
      run,
      stop,
      sessionInfo,
      getRecipe,
      isSessionBusy = () => false,
      now = Date.now,
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
      timers = true,
    } = {},
  ) {
    if (!store.directory || !path.isAbsolute(store.directory))
      throw invalid("A scheduler data directory is required");
    this.store = store;
    this.run = run;
    this.stop = stop;
    this.sessionInfo = sessionInfo;
    this.getRecipe = getRecipe;
    this.isSessionBusy = isSessionBusy;
    this.now = now;
    this.timeZone = timeZone;
    this.timers = timers;
    this.active = new Map();
    this.tail = Promise.resolve();
    this.timer = null;
    this.started = false;
    this.closed = false;
    this.recipeRoot = path.join(
      store.directory,
      "library",
      "scheduled-recipes",
    );
  }

  serial(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  reserveShutdownIfIdle(reserveRuntime) {
    // Join the same queue as beginRun: a run whose state is still being saved
    // must become visible before an update may claim an idle scheduler.
    return this.serial(() => {
      if (this.closed || this.active.size || !reserveRuntime()) return false;
      this.closed = true;
      return true;
    });
  }

  handles(method) {
    return (
      (actions.has(method.slice(prefix.length)) && method.startsWith(prefix)) ||
      method === "_goose/unstable/recipes/schedule"
    );
  }

  rows() {
    return this.store.read().schedules ?? [];
  }
  find(id) {
    const row = this.rows().find((entry) => entry.id === id);
    if (!row) throw invalid("Scheduled task was not found");
    return row;
  }
  dto(row) {
    return {
      id: row.id,
      source: row.source,
      cron: row.cron,
      lastRun: row.lastRun ?? null,
      currentlyRunning: Boolean(row.currentlyRunning),
      paused: Boolean(row.paused),
      tested: Boolean(row.tested),
      currentSessionId: row.currentSessionId ?? null,
      jobStartTime: row.jobStartTime ?? null,
      workspaceMode: row.workspaceMode,
      executionMode: row.executionMode ?? "new_session",
      targetSessionId: row.targetSessionId ?? null,
      lastError: row.lastError ?? null,
    };
  }
  next(row, now = this.now()) {
    try {
      return createCronScheduleRecord(
        row.id,
        row.recipe.prompt?.trim() || row.recipe.instructions,
        {
          expression: row.expression,
          time_zone: row.timeZone,
        },
        now,
        row.recipe.title.slice(0, 120),
      ).scheduledAt;
    } catch (error) {
      throw invalid(`Invalid scheduled occurrence: ${error.message}`);
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    await this.store.update((state) => {
      for (const row of state.schedules ?? []) {
        if (row.currentlyRunning) {
          row.lastOutcome = "interrupted";
          row.currentlyRunning = false;
          row.paused = true;
          row.tested = false;
          row.currentSessionId = null;
          row.jobStartTime = null;
          if (row.attempts?.at(-1)?.status === "running")
            row.attempts.at(-1).status = "interrupted";
        }
        if (!row.tested) row.paused = true;
        // Re-arm from now. No missed or in-flight occurrence is replayed.
        row.nextRun = this.next(row);
      }
    });
    this.arm();
  }

  arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.closed || !this.timers) return;
    const due = this.rows()
      .filter((row) => !row.paused && !row.currentlyRunning)
      .map((row) => Date.parse(row.nextRun));
    if (!due.length) return;
    const delay = Math.max(25, Math.min(60_000, Math.min(...due) - this.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch(() => {})
        .finally(() => this.arm());
    }, delay);
    this.timer.unref?.();
  }

  async writeRecipe(id, recipe) {
    await mkdir(this.recipeRoot, { recursive: true });
    const file = path.join(this.recipeRoot, `${digest(id)}.yaml`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, YAML.stringify(recipe), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return file;
  }

  async create(input, recipeId) {
    if (
      typeof input.id !== "string" ||
      !input.id.trim() ||
      input.id.length > 120 ||
      /[\\/\0]/u.test(input.id)
    )
      throw invalid("A schedule name without path separators is required");
    if (input.paused !== undefined && typeof input.paused !== "boolean")
      throw invalid("paused must be a boolean");
    if (
      input.workspaceMode !== undefined &&
      !["code", "codepro"].includes(input.workspaceMode)
    )
      throw invalid("Invalid schedule workspace mode");
    const recipe = recipeValue(input.recipe);
    const executionMode = input.executionMode ?? "new_session";
    if (!["new_session", "current_session"].includes(executionMode))
      throw invalid("Invalid automatic task execution mode");
    if (
      executionMode === "current_session" &&
      (recipe.settings ||
        recipe.extensions?.length ||
        recipe.parameters?.length)
    )
      throw invalid(
        "Current-chat follow-ups use the chat's existing model and tools; enter plain task instructions",
      );
    if (executionMode === "new_session" && input.targetSessionId != null)
      throw invalid("Only a current-chat task can bind a session");
    const timing = cronExpression(input.cron, this.timeZone);
    const id = input.id.trim();
    return this.serial(async () => {
      if (this.rows().some((row) => row.id === id))
        throw invalid("A task with this schedule name already exists");
      let targetSessionId = null;
      if (executionMode === "current_session") {
        if (typeof input.targetSessionId !== "string" || !input.targetSessionId)
          throw invalid("Choose a current chat for this automatic task");
        const target = await this.sessionInfo?.(input.targetSessionId);
        if (
          !target ||
          target._meta?.readonlyHistory ||
          target._meta?.archivedAt
        )
          throw invalid("The target chat is missing, archived or read-only");
        targetSessionId = input.targetSessionId;
      }
      const protectedRecipeExtensions = recipe.extensions?.length
        ? await protectSecret(JSON.stringify(recipe.extensions))
        : null;
      const displayRecipe = recipe.extensions?.length
        ? { ...recipe, extensions: [] }
        : recipe;
      const row = {
        id,
        recipe: displayRecipe,
        protectedRecipeExtensions,
        recipeId: recipeId ?? null,
        source: "",
        cron: input.cron.trim(),
        expression: timing.expression,
        timeZone: timing.timeZone,
        workspaceMode: input.workspaceMode ?? "codepro",
        executionMode,
        targetSessionId,
        paused: input.paused ?? true,
        tested: false,
        currentlyRunning: false,
        lastRun: null,
        currentSessionId: null,
        jobStartTime: null,
        sessions: [],
        attempts: [],
      };
      row.nextRun = this.next(row);
      row.source = await this.writeRecipe(id, displayRecipe);
      await this.store.update((state) => {
        (state.schedules ??= []).push(row);
      });
      this.arm();
      return { job: this.dto(row) };
    });
  }

  async request(method, input = {}) {
    if (!this.handles(method)) return undefined;
    if (method === "_goose/unstable/recipes/schedule") {
      if (typeof this.getRecipe !== "function")
        throw invalid("Recipe scheduling is not configured");
      const existing = this.rows().find((row) => row.recipeId === input.id);
      if (input.cron_schedule == null || input.cron_schedule === "") {
        if (existing)
          await this.request(prefix + "delete", { scheduleId: existing.id });
        return {};
      }
      if (existing) {
        await this.request(prefix + "update", {
          scheduleId: existing.id,
          cron: input.cron_schedule,
        });
        return {};
      }
      await this.create(
        {
          id: `recipe-${digest(input.id)}`,
          recipe: await this.getRecipe(input.id),
          cron: input.cron_schedule,
          paused: true,
          workspaceMode: "codepro",
        },
        input.id,
      );
      return {};
    }
    const action = method.slice(prefix.length);
    if (action === "list")
      return { jobs: this.rows().map((row) => this.dto(row)) };
    if (action === "create") return this.create(input);
    if (action === "run-now") {
      const active = await this.beginRun(input.scheduleId);
      return active.done;
    }
    if (action === "running-job/inspect") {
      const row = this.find(input.jobId);
      return {
        running: row.currentlyRunning,
        sessionId: row.currentSessionId,
        jobStartTime: row.jobStartTime,
        runningDurationSeconds: row.jobStartTime
          ? Math.max(
              0,
              Math.floor((this.now() - Date.parse(row.jobStartTime)) / 1000),
            )
          : null,
      };
    }
    if (action === "running-job/kill") return this.kill(input.jobId);
    if (action === "sessions/list") {
      const row = this.find(input.scheduleId);
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 0 ||
        input.limit > 1000
      )
        throw invalid("Session limit must be between 0 and 1000");
      if (!this.sessionInfo)
        throw invalid("Schedule session lookup is not configured");
      if (input.limit === 0) return { sessions: [] };
      return {
        sessions: (
          await Promise.all(
            (row.sessions ?? [])
              .slice(-input.limit)
              .reverse()
              .map((sessionId) => this.sessionInfo(sessionId)),
          )
        ).filter((session) => session !== null),
      };
    }
    return this.serial(async () => {
      this.find(input.scheduleId);
      const result = await this.store.update((state) => {
        const row = state.schedules.find(
          (entry) => entry.id === input.scheduleId,
        );
        if (action === "delete") {
          if (row.currentlyRunning)
            throw invalid("Stop the running task before deleting its schedule");
          state.schedules = state.schedules.filter((entry) => entry !== row);
          return {};
        }
        if (action === "pause") {
          row.paused = true;
          return {};
        }
        if (action === "unpause") {
          if (!row.tested)
            throw invalid(
              "Run this automatic task successfully before enabling its schedule",
            );
          row.paused = false;
          row.nextRun = this.next(row);
          return {};
        }
        if (action === "update") {
          const timing = cronExpression(input.cron, row.timeZone);
          row.cron = input.cron.trim();
          row.expression = timing.expression;
          row.nextRun = this.next(row);
          return { job: this.dto(row) };
        }
        throw invalid("Unknown schedule action");
      });
      this.arm();
      return result;
    });
  }

  async beginRun(id, automatic = false) {
    return this.serial(async () => {
      if (this.closed) throw invalid("Scheduler is closed");
      if (!this.run) throw invalid("Schedule execution is not configured");
      const row = this.find(id);
      if (
        automatic &&
        (this.active.has(id) ||
          row.currentlyRunning ||
          row.paused ||
          Date.parse(row.nextRun) > this.now())
      )
        return null;
      if (this.active.has(id) || row.currentlyRunning)
        throw invalid("This scheduled task is already running");
      if (automatic && row.paused)
        throw invalid("This scheduled task is paused");
      if (
        row.executionMode === "current_session" &&
        (this.isSessionBusy(row.targetSessionId) ||
          [...this.active.values()].some(
            (run) => run.targetSessionId === row.targetSessionId,
          ))
      ) {
        if (!automatic)
          throw invalid("The target chat is busy; try again when it finishes");
        await this.store.update((state) => {
          const stored = state.schedules.find((item) => item.id === id);
          stored.nextRun = this.next(stored);
          stored.lastOutcome = "skipped";
          (stored.attempts ??= []).push({
            id: randomUUID(),
            status: "skipped",
            trigger: "scheduled",
            startedAt: new Date(this.now()).toISOString(),
            finishedAt: new Date(this.now()).toISOString(),
            reason: "target_busy",
          });
        });
        return null;
      }
      const attemptId = randomUUID();
      const startedAt = new Date(this.now()).toISOString();
      const controller = new AbortController();
      const active = {
        id,
        attemptId,
        controller,
        sessionId: null,
        done: null,
        targetSessionId:
          row.executionMode === "current_session" ? row.targetSessionId : null,
      };
      await this.store.update((state) => {
        const stored = state.schedules.find((item) => item.id === id);
        stored.currentlyRunning = true;
        stored.jobStartTime = startedAt;
        stored.currentSessionId = null;
        stored.lastRun = startedAt;
        stored.nextRun = this.next(stored);
        (stored.attempts ??= []).push({
          id: attemptId,
          status: "running",
          startedAt,
          trigger: automatic ? "scheduled" : "manual",
        });
      });
      this.active.set(id, active);
      active.done = this.execute(row, active);
      // The caller may attach later (timer mode); never leave a rejected run unobserved.
      active.done.catch(() => {});
      return active;
    });
  }

  async execute(job, active) {
    let result;
    let failure;
    try {
      const executionJob = structuredClone(job);
      if (executionJob.protectedRecipeExtensions) {
        executionJob.recipe.extensions = JSON.parse(
          await revealSecret(executionJob.protectedRecipeExtensions),
        );
        delete executionJob.protectedRecipeExtensions;
      }
      result = await this.run(executionJob, {
        signal: active.controller.signal,
        onSession: async (sessionId) => {
          if (typeof sessionId !== "string" || !sessionId)
            throw invalid("The schedule runner returned an invalid session id");
          if (
            job.executionMode === "current_session" &&
            sessionId !== job.targetSessionId
          )
            throw invalid("The follow-up must run in its bound chat");
          active.sessionId = sessionId;
          await this.store.update((state) => {
            const row = state.schedules.find((entry) => entry.id === job.id);
            if (!row || row.attempts?.at(-1)?.id !== active.attemptId)
              throw invalid("The schedule attempt is no longer current");
            row.currentSessionId = sessionId;
            if (!row.sessions.includes(sessionId)) row.sessions.push(sessionId);
            row.attempts.at(-1).sessionId = sessionId;
          });
        },
      });
      if (!result || !["completed", "cancelled"].includes(result.status))
        throw invalid(
          "The schedule runner must return a structured completed or cancelled result",
        );
      if (result.sessionId && active.sessionId !== result.sessionId)
        throw invalid(
          "The schedule result does not match its recorded session",
        );
      if (result.status === "completed" && !active.sessionId)
        throw invalid("A completed schedule needs a recorded session");
    } catch (error) {
      failure = error;
    }
    const status =
      active.controller.signal.aborted || result?.status === "cancelled"
        ? "cancelled"
        : failure
          ? "failed"
          : "completed";
    await this.store.update((state) => {
      const row = state.schedules.find((entry) => entry.id === job.id);
      if (!row || row.attempts?.at(-1)?.id !== active.attemptId) return;
      row.currentlyRunning = false;
      row.currentSessionId = null;
      row.jobStartTime = null;
      row.lastOutcome = status;
      row.lastError = failure ? String(failure.message).slice(0, 500) : null;
      row.attempts.at(-1).status = status;
      row.attempts.at(-1).finishedAt = new Date(this.now()).toISOString();
      if (failure)
        row.attempts.at(-1).error = String(failure.message).slice(0, 500);
      if (status === "completed") row.tested = true;
      else {
        row.paused = true;
        row.tested = false;
      }
    });
    this.active.delete(job.id);
    this.arm();
    if (failure && status !== "cancelled") throw failure;
    return { status, sessionId: active.sessionId };
  }

  async kill(id) {
    this.find(id);
    const active = this.active.get(id);
    if (!active) return { message: "The scheduled task is not running" };
    active.controller.abort();
    // Follow-ups share a chat with manual turns. Their runner owns scoped
    // cancellation; a session-wide stop here could cancel a later manual turn.
    if (active.sessionId && !active.targetSessionId && this.stop)
      await this.stop(active.sessionId);
    await active.done;
    return { message: "The scheduled task was cancelled" };
  }

  async stopSessionSchedules(sessionId) {
    await this.serial(() =>
      this.store.update((state) => {
        for (const row of state.schedules ?? []) {
          if (
            row.executionMode !== "current_session" ||
            row.targetSessionId !== sessionId
          )
            continue;
          if (row.currentlyRunning)
            throw invalid(
              "Stop the automatic follow-up before deleting its chat",
            );
          row.paused = true;
          row.tested = false;
          row.lastError = "The linked chat was deleted";
        }
      }),
    );
    this.arm();
  }

  async tick() {
    if (!this.started || this.closed) return [];
    const due = this.rows().filter(
      (row) =>
        !row.paused &&
        !row.currentlyRunning &&
        Date.parse(row.nextRun) <= this.now(),
    );
    const started = [];
    for (const row of due) {
      if (this.closed) break;
      const current = this.find(row.id);
      if (
        current.paused ||
        current.currentlyRunning ||
        Date.parse(current.nextRun) > this.now()
      )
        continue;
      try {
        const active = await this.beginRun(row.id, true);
        if (active) started.push(active.id);
      } catch (error) {
        if (this.closed) break;
        // A broken persisted rule or missing runner pauses this job instead of
        // becoming a tight retry loop. The failed occurrence remains visible.
        await this.store.update((state) => {
          const stored = state.schedules.find((entry) => entry.id === row.id);
          if (!stored) return;
          stored.paused = true;
          stored.tested = false;
          stored.lastOutcome = "failed";
          stored.lastError = String(error.message).slice(0, 500);
        });
      }
    }
    this.arm();
    return started;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tail;
    const runs = [...this.active.values()];
    for (const active of runs) {
      active.controller.abort();
      if (active.sessionId && !active.targetSessionId && this.stop)
        await this.stop(active.sessionId);
    }
    const results = await Promise.allSettled(runs.map((active) => active.done));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
