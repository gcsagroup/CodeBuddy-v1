import { randomUUID } from 'node:crypto';

const VERSION = 1;
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'fatal', 'exhausted']);
const LIVE = new Set(['planning', 'running', 'recovering', 'repairing', 'retesting', 'completing']);
const ACTIVE_EFFECTS = new Set(['pending', 'claimed', 'uncertain', 'unknown']);
const fail = (message, code = -32602) => Object.assign(new Error(message), { code });
const copy = (value) => structuredClone(value);
const text = (value, name, max = 32_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
};
const identity = (value, name) => text(value, name, 512);
const key = (params) => ({ sessionId: identity(params.sessionId, 'sessionId'), runId: identity(params.runId, 'runId') });
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
  return value;
}
function protocol(params) {
  if (params.schemaVersion !== VERSION) throw fail('Unsupported CodePro schemaVersion');
  key(params);
}
function rowIn(state, params) {
  const row = (state.codeproRuns ?? []).find((run) => run.sessionId === params.sessionId && run.runId === params.runId);
  if (!row) throw fail('CodePro run not found');
  return row;
}
function event(row, type, payload = {}) {
  const entry = { eventId: randomUUID(), sequence: row.events.length + 1, eventType: type, occurredAt: new Date().toISOString(), payload: copy(payload) };
  row.events.push(entry);
  return entry;
}

// New Harness-owned runs cache presentation facts only. Native session events
// remain authoritative; legacy events retain their historical interpretation.
function project(row) {
  const state = { state: 'not_started', goal: '', planRevision: 0, tasks: [], agents: [], nativeWorkers: [], effects: [], receipts: [], activeAttempt: null, sourceMessageId: '', policy: {}, stopRequested: false, lastReason: null, completionKind: null, executionOwner: 'legacy', nativeGoal: null, terminalError: null };
  for (const entry of row.events) {
    const p = entry.payload;
    switch (entry.eventType) {
      case 'run_created':
        Object.assign(state, { state: 'planning', goal: p.goal, sourceMessageId: p.sourceMessageId, policy: p.policy, executionOwner: p.executionOwner ?? 'legacy' });
        break;
      case 'execution_owner_changed':
        state.executionOwner = p.executionOwner;
        state.policy = { requirePlan: false, requireEvidence: false, requireVerification: false };
        break;
      case 'attempt_started':
        Object.assign(state, { state: 'running', activeAttempt: p.attemptId, sourceMessageId: p.sourceMessageId, stopRequested: false, lastReason: null, completionKind: null, terminalError: null });
        break;
      case 'harness_event':
        projectHarnessEvent(state, p);
        break;
      case 'harness_attempt_finished':
        state.activeAttempt = null;
        if (state.state !== 'cancelled') {
          state.state = p.state;
          state.completionKind = p.completionKind;
          state.lastReason = p.reason;
          state.terminalError = p.error ?? null;
          if (p.goal !== undefined) state.nativeGoal = p.goal;
        }
        break;
      case 'plan_submitted':
        state.planRevision += 1;
        state.tasks = p.tasks.map((task) => {
          const previous = state.tasks.find((existing) => existing.taskId === task.taskId);
          return previous ? { ...previous, ...task } : { ...task, state: 'ready', retryAttempts: 0, evidence: [], inCurrentPlan: true };
        });
        break;
      case 'task_started': {
        const task = state.tasks.find((item) => item.taskId === p.taskId);
        if (task.state !== 'ready') task.retryAttempts += 1;
        Object.assign(task, { state: 'running', startedSequence: entry.sequence });
        break;
      }
      case 'task_result': {
        const task = state.tasks.find((item) => item.taskId === p.taskId);
        Object.assign(task, { state: p.outcome, resultSummary: p.summary, evidence: p.evidenceIds.map((id) => {
          const receipt = state.receipts.find((item) => item.eventId === id);
          return { eventId: id, artifactRef: receipt.artifactRef };
        }) });
        break;
      }
      case 'tool_dispatched':
        state.effects.push({ effectId: p.callId, triggerEventId: entry.eventId, state: 'pending', summary: p.name, requiresResolution: false, ...p, startedSequence: entry.sequence });
        break;
      case 'tool_result': {
        const effect = state.effects.find((item) => item.effectId === p.callId);
        Object.assign(effect, { state: p.outcome === 'unknown' ? 'uncertain' : 'completed', requiresResolution: p.outcome === 'unknown' });
        state.receipts.push({ ...p, taskId: effect.taskId, attemptId: effect.attemptId, eventId: entry.eventId, sequence: entry.sequence });
        break;
      }
      case 'worker_started':
        state.agents.push({ agentId: p.agentId, taskId: p.taskId, role: p.role, state: 'running' });
        break;
      case 'worker_task_assigned': {
        const agent = state.agents.find((item) => item.agentId === p.agentId);
        agent.taskId = p.taskId;
        break;
      }
      case 'worker_stopped': {
        const agent = state.agents.find((item) => item.agentId === p.agentId);
        if (agent) agent.state = p.crashed ? 'crashed' : 'stopped';
        break;
      }
      case 'pause_requested':
        state.state = 'paused';
        state.stopRequested = true;
        state.lastReason = p.reason;
        for (const task of state.tasks) if (task.state === 'running') task.state = 'paused';
        break;
      case 'run_resumed':
        Object.assign(state, { state: 'recovering', stopRequested: false, lastReason: null });
        break;
      case 'run_cancelled':
        state.state = 'cancelled';
        for (const task of state.tasks) if (!['succeeded', 'failed', 'cancelled', 'skipped'].includes(task.state)) task.state = 'cancelled';
        break;
      case 'tasks_cancelled':
        for (const task of state.tasks) if (p.taskIds.includes(task.taskId) && task.state !== 'succeeded') task.state = 'cancelled';
        break;
      case 'attempt_finished':
        state.activeAttempt = null;
        if (LIVE.has(state.state)) state.state = 'paused';
        state.lastReason = p.reason;
        for (const task of state.tasks) if (task.state === 'running') task.state = 'paused';
        break;
      case 'run_blocked':
        state.state = p.kind === 'environment' ? 'waiting_for_environment' : 'waiting_for_user';
        state.stopRequested = true;
        state.lastReason = p.reason;
        break;
      case 'run_completed':
        state.state = 'completed';
        state.completionKind = 'verified_task';
        state.lastReason = p.summary;
        break;
      case 'response_completed':
        state.state = 'completed';
        state.completionKind = 'response_only';
        state.lastReason = p.answer;
        break;
      case 'process_interrupted':
        if (!TERMINAL.has(state.state)) state.state = 'paused';
        state.activeAttempt = null;
        state.lastReason = 'Backend process interrupted; inspect unresolved effects before resuming';
        state.stopRequested = true;
        for (const task of state.tasks) if (task.state === 'running') task.state = 'paused';
        for (const agent of state.agents) if (['starting', 'running', 'stopping'].includes(agent.state)) agent.state = 'crashed';
        break;
      case 'effects_interrupted':
        for (const effect of state.effects) if (p.effectIds.includes(effect.effectId)) Object.assign(effect, { state: 'uncertain', requiresResolution: true });
        break;
      case 'effect_resolved': {
        const effect = state.effects.find((item) => item.effectId === p.effectId);
        Object.assign(effect, { state: p.resolution === 'confirmed_applied' ? 'completed' : 'abandoned', requiresResolution: false });
        break;
      }
    }
  }
  return state;
}

function projectHarnessEvent(state, record) {
  const native = record.event;
  const data = native.data;
  if (native.type === 'turn/start') {
    // The official todo projection resets at each native turn boundary.
    if (state.tasks.length) state.planRevision += 1;
    state.tasks = [];
  } else if (native.type === 'todo/write') {
    // Upstream todos are whole-list snapshots without stable task identities.
    // These identifiers only address one displayed revision, never a DAG.
    state.planRevision += 1;
    state.tasks = data.todos.map((todo, index) => ({
      taskId: `harness-todo:${record.nativeSessionId}:${native.seq}:${index}`,
      name: todo.content,
      state: { pending: 'ready', in_progress: 'running', completed: 'succeeded' }[todo.status],
      dependsOn: [], kind: 'analysis', retryAttempts: 0, evidence: [], inCurrentPlan: true,
      source: 'harness_todo',
    }));
  } else if (native.type === 'goal/change') {
    state.nativeGoal = data.operation === 'clear' ? null : { ...data.goal, roundsStarted: data.roundsStarted };
    // A goal completion event precedes its final assistant turn. Do not end the
    // user-visible stream or manufacture verification receipts here.
  } else if (native.type === 'subagent/start' || native.type === 'subagent/end') {
    const worker = state.nativeWorkers.find((item) => item.runId === data.runId);
    const next = { ...data, state: native.type === 'subagent/start' ? 'running' : 'stopped' };
    if (worker) Object.assign(worker, next);
    else state.nativeWorkers.push(next);
    if (['planner', 'coder', 'tester', 'reviewer'].includes(data.role)) {
      const agent = state.agents.find((item) => item.agentId === data.id);
      const projection = { agentId: data.id, taskId: null, role: data.role, state: next.state };
      if (agent) Object.assign(agent, projection);
      else state.agents.push(projection);
    }
  }
}

function nativeTerminal({ result, error, aborted }, view) {
  const goal = result?.goal !== undefined ? result.goal : view.nativeGoal;
  const reason = result?.reason;
  const code = reason?.kind ?? ({ end_turn: 'completed', cancelled: 'aborted', max_tokens: 'max-tokens', max_turns: 'max-turns', refusal: 'blocked' })[result?.stopReason];
  const failure = error ?? (code === 'error' ? reason.error : null);
  if (aborted || view.stopRequested || code === 'aborted' || code === 'interrupted') return { state: 'paused', completionKind: null, reason: 'CodeBuddy execution paused', goal };
  if (failure) return { state: 'failed', completionKind: null, reason: failure.message ?? String(failure), error: { message: failure.message ?? String(failure), ...(failure.code !== undefined ? { code: failure.code } : {}) }, goal };
  if (code !== 'completed' || result?.stopReason === 'max_turns') return { state: 'paused', completionKind: null, reason: `CodeBuddy stopped: ${result?.stopReason ?? code ?? 'unknown'}`, goal };
  if (goal && goal.phase !== 'complete') return { state: 'paused', completionKind: null, reason: goal.blockedReason?.message ?? `CodeBuddy goal is ${goal.phase}`, goal };
  // A session retains its last completed goal. A later ordinary reply must not
  // claim that a new run completed that previous goal again.
  const completedRunGoal = goal && view.nativeGoal?.id === goal.id;
  return { state: 'completed', completionKind: completedRunGoal ? 'harness_goal' : 'harness_turn', reason: completedRunGoal ? 'CodeBuddy goal completed' : 'CodeBuddy turn completed', goal };
}

function snapshot(row) {
  const view = project(row);
  return {
    schemaVersion: VERSION, sessionId: row.sessionId, runId: row.runId,
    state: view.state, goal: view.goal, planRevision: view.planRevision, lastSequence: row.events.length,
    tasks: view.tasks.map(({ taskId, name, state, retryAttempts, resultSummary, evidence, inCurrentPlan }) => ({ taskId, name, state, retryAttempts, ...(resultSummary ? { resultSummary } : {}), evidence, inCurrentPlan })),
    agents: view.agents,
    effects: view.effects.map(({ effectId, triggerEventId, state, summary, requiresResolution }) => ({ effectId, triggerEventId, state, summary, requiresResolution })),
    recentEvents: row.events.slice(-100).map(({ eventId, sequence, eventType, occurredAt, payload }) => ({ eventId, sequence, eventType, occurredAt, ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(payload.agentId ? { agentId: payload.agentId } : {}) })),
    coordinator: { requestedMode: 'off', effectiveMode: 'off', qualification: 'not_required', reason: 'Harness owns agent execution; this adapter projects host receipts and controls' },
    recovery: { truncatedEventBytes: 0, truncatedEffectBytes: 0, pendingEffects: view.effects.filter((item) => ['pending', 'claimed'].includes(item.state)).length, uncertainEffects: view.effects.filter((item) => item.requiresResolution).length, abandonedEffects: view.effects.filter((item) => item.state === 'abandoned').length },
  };
}

function assertMutable(view) {
  if (TERMINAL.has(view.state)) throw fail(`Run is terminal: ${view.state}`);
}
function assertAttempt(view, attemptId) {
  identity(attemptId, 'attemptId');
  if (view.activeAttempt !== attemptId) throw fail('Stale or inactive Harness attempt');
}
function assertActing(view, attemptId) {
  assertMutable(view);
  assertAttempt(view, attemptId);
  if (view.stopRequested || !LIVE.has(view.state)) throw fail('Run is paused or waiting; new actions are suspended');
}
function taskIn(view, taskId) {
  const task = view.tasks.find((item) => item.taskId === taskId);
  if (!task) throw fail('Task is not in the current plan');
  return task;
}
function unresolved(view) { return view.effects.filter((item) => ACTIVE_EFFECTS.has(item.state)); }
function interruptPending(row, view) {
  const effectIds = view.effects.filter((item) => ['pending', 'claimed'].includes(item.state)).map((item) => item.effectId);
  if (effectIds.length) event(row, 'effects_interrupted', { effectIds });
}
function validatePlan(tasks, previous) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 500) throw fail('Plan must contain 1 to 500 tasks');
  const normalized = tasks.map((task) => ({ taskId: identity(task.taskId, 'taskId'), name: text(task.name, 'task.name', 2000), dependsOn: [...new Set(task.dependsOn ?? [])].map((id) => identity(id, 'dependency')), kind: task.kind ?? 'implementation' }));
  const ids = new Set(normalized.map((task) => task.taskId));
  if (ids.size !== normalized.length) throw fail('Duplicate task identity');
  for (const task of previous) if (!ids.has(task.taskId)) throw fail('Plan revision must retain existing task identities and obligations');
  for (const task of normalized) {
    if (!['implementation', 'verification', 'analysis'].includes(task.kind)) throw fail('Unknown task kind');
    if (task.dependsOn.some((id) => !ids.has(id) || id === task.taskId)) throw fail('Invalid task dependency');
    const old = previous.find((item) => item.taskId === task.taskId);
    if (old && ['running', 'succeeded'].includes(old.state) && !same({ name: old.name, dependsOn: old.dependsOn, kind: old.kind }, { name: task.name, dependsOn: task.dependsOn, kind: task.kind })) throw fail('Active or completed task contract cannot be rewritten');
  }
  const visited = new Set(); const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw fail('Cyclic plan dependency');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of normalized.find((task) => task.taskId === id).dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return normalized;
}

function activity(row, entry) {
  const view = project(row);
  const p = entry.payload;
  if (p.internal === true && ['tool_dispatched', 'tool_result'].includes(entry.eventType)) return null;
  if (view.executionOwner === 'harness' && ['run_created', 'attempt_started', 'run_resumed'].includes(entry.eventType)) return null;
  if (entry.eventType === 'harness_attempt_finished' && p.state === 'completed' && p.completionKind === 'harness_turn' &&
      view.receipts.length === 0 && view.tasks.length === 0 && view.nativeWorkers.length === 0 && unresolved(view).length === 0) return null;
  const types = { run_created: 'intent_started', attempt_started: 'task_started', plan_submitted: 'plan_created', task_started: 'task_started', task_result: p.outcome === 'succeeded' ? 'task_completed' : 'task_failed', tool_dispatched: 'tool_started', tool_result: 'tool_completed', run_completed: 'run_completed', run_cancelled: 'run_stopped', pause_requested: 'run_stopped', process_interrupted: 'run_stopped', attempt_finished: 'run_stopped', run_blocked: 'run_stopped', run_resumed: 'task_started' };
  const observedToolType = entry.eventType === 'tool_result' ? p.kind === 'verification' ? 'test_completed' : p.kind === 'command' ? 'command_completed' : p.outcome === 'succeeded' && p.kind === 'write' && p.path ? 'file_changed' : p.outcome === 'succeeded' && p.kind === 'read' && p.path ? 'file_read' : 'tool_completed' : null;
  const nativeType = entry.eventType === 'harness_event' && p.event.type === 'todo/write' ? 'plan_created' : null;
  const nativeEnd = entry.eventType === 'harness_attempt_finished';
  const eventType = nativeEnd ? p.state === 'completed' ? 'run_completed' : p.state === 'failed' ? 'run_failed' : 'run_stopped' : entry.eventType === 'response_completed' || entry.eventType === 'attempt_finished' && view.state === 'completed' ? 'run_completed' : nativeType ?? observedToolType ?? types[entry.eventType];
  if (!eventType) return null;
  const ending = nativeEnd || ['task_result', 'tool_result', 'run_completed', 'response_completed', 'run_cancelled', 'pause_requested', 'process_interrupted', 'attempt_finished', 'run_blocked'].includes(entry.eventType);
  const status = eventType === 'run_completed' || p.outcome === 'succeeded' ? 'completed' : p.state === 'failed' || p.outcome === 'failed' ? 'failed' : entry.eventType === 'run_cancelled' ? 'cancelled' : entry.eventType === 'process_interrupted' || p.outcome === 'unknown' ? 'interrupted' : ending ? 'stopped' : 'running';
  return { schema_version: 1, event_id: entry.eventId, tool_call_id: p.callId, event_type: eventType, session_id: row.sessionId, run_id: row.runId, task_id: p.taskId ?? null, parent_task_id: null, agent_role: null, effective_model: null, status, started_at: entry.occurredAt, finished_at: ending ? entry.occurredAt : null, title: p.summary ?? p.reason ?? p.name ?? view.goal, technical_details: null, path: p.path ?? null, command_summary: p.command ?? null, exit_code: p.exitCode ?? null, diff_summary: null, include_in_model_context: false, retryable: !TERMINAL.has(view.state), retry_from_event_id: null };
}

export class CodeProRuns {
  constructor(store, { onUpdate = () => {}, onCancel, onResume } = {}) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.onCancel = onCancel;
    this.onResume = onResume;
  }
  async initialize() {
    const changed = await this.store.update((state) => {
      state.codeproRuns ??= [];
      const updated = [];
      for (const row of state.codeproRuns) {
        if (row.version !== VERSION) throw fail('Unsupported persisted CodePro version');
        const view = project(row);
        if (!view.activeAttempt && !LIVE.has(view.state) && !view.effects.some((item) => ['pending', 'claimed'].includes(item.state))) continue;
        interruptPending(row, view);
        event(row, 'process_interrupted');
        updated.push(copy(row));
      }
      return updated;
    }, ['codeproRuns']);
    for (const row of changed) this.publish(row);
    return changed.length;
  }
  publish(row, fromSequence = row.events.length - 1) {
    const notifications = row.events.slice(fromSequence).map((entry) => activity(row, entry)).filter(Boolean).map((data) => ({ sessionId: row.sessionId, update: { sessionUpdate: 'status_message', status: { type: 'progress', message: data.title, data } } }));
    // Observer failures never roll back already committed host facts.
    try { Promise.resolve(this.onUpdate({ snapshot: snapshot(row), notifications })).catch(() => {}); } catch {}
  }
  async mutate(params, change) {
    key(params);
    const result = await this.store.update((state) => {
      const row = rowIn(state, params); const previousSequence = row.events.length;
      const value = change(row, project(row));
      return { row: copy(row), previousSequence, value };
    }, ['codeproRuns']);
    if (result.row.events.length !== result.previousSequence) this.publish(result.row, result.previousSequence);
    return { snapshot: snapshot(result.row), ...result.value };
  }
  async create({ sessionId, goal, sourceMessageId, runId = randomUUID(), policy = {}, executionOwner = 'legacy' }) {
    identity(sessionId, 'sessionId'); identity(runId, 'runId'); identity(sourceMessageId, 'sourceMessageId'); text(goal, 'goal');
    if (!['legacy', 'harness'].includes(executionOwner)) throw fail('Unknown execution owner');
    const completionPolicy = executionOwner === 'harness' ? { requirePlan: false, requireEvidence: false, requireVerification: false } : { requirePlan: true, requireEvidence: true, requireVerification: true, ...policy };
    for (const name of ['requirePlan', 'requireEvidence', 'requireVerification']) if (typeof completionPolicy[name] !== 'boolean') throw fail(`Invalid completion policy ${name}`);
    const row = await this.store.update((state) => {
      state.codeproRuns ??= [];
      if (state.codeproRuns.some((run) => run.runId === runId)) throw fail('Run identity already exists');
      if (state.codeproRuns.some((run) => run.sessionId === sessionId && !TERMINAL.has(project(run).state))) throw fail('Session already has an unfinished run');
      const next = { version: VERSION, sessionId, runId, events: [], commands: [] };
      event(next, 'run_created', { goal, sourceMessageId, policy: completionPolicy, executionOwner });
      state.codeproRuns.push(next); return copy(next);
    }, ['codeproRuns']);
    this.publish(row, 0);
    return snapshot(row);
  }
  get(params) { protocol(params); return { snapshot: snapshot(rowIn(this.store.read(['codeproRuns']), params)) }; }
  latest(sessionId, state = this.store.read(['codeproRuns'])) {
    const row = (state.codeproRuns ?? []).findLast((run) => run.sessionId === sessionId);
    return row ? snapshot(row) : null;
  }
  context(params) {
    const row = rowIn(this.store.read(['codeproRuns']), key(params)); const view = project(row);
    return { ...snapshot(row), sourceMessageId: view.sourceMessageId, activeAttempt: view.activeAttempt, completionPolicy: view.policy, completionKind: view.completionKind, executionOwner: view.executionOwner, nativeGoal: view.nativeGoal, nativeWorkers: view.nativeWorkers, terminalError: view.terminalError, tasks: view.tasks, receipts: view.receipts, lastReason: view.lastReason,
      recoveryInstruction: view.executionOwner === 'harness' ? 'Continue from the official Harness session and goal state. Do not replay completed or unresolved external effects. Inspect uncertain effects before deciding further actions. This compatibility view is not a scheduler or a project verification verdict.' : 'Continue from persisted Harness conversation and these host facts. Do not replay completed or unresolved external effects. Inspect uncertain effects and request a user resolution. End of a model turn does not complete this run.' };
  }
  async beginAttempt(params) {
    identity(params.sourceMessageId, 'sourceMessageId');
    const attemptId = randomUUID();
    return this.mutate(params, (row, view) => {
      assertMutable(view);
      if (view.activeAttempt) throw fail('Run already has an active Harness attempt');
      if (params.executionOwner !== undefined && params.executionOwner !== 'harness') throw fail('Execution ownership may only migrate to Harness');
      const harnessOwned = view.executionOwner === 'harness' || params.executionOwner === 'harness';
      if (!harnessOwned && unresolved(view).length) throw fail('Resolve pending or uncertain effects before continuing');
      if (params.executionOwner === 'harness' && view.executionOwner !== 'harness') event(row, 'execution_owner_changed', { executionOwner: 'harness' });
      event(row, 'attempt_started', { attemptId, sourceMessageId: params.sourceMessageId });
      return { attemptId };
    });
  }
  async endAttempt(params) {
    return this.mutate(params, (row, view) => {
      assertAttempt(view, params.attemptId);
      interruptPending(row, view);
      event(row, 'attempt_finished', { attemptId: params.attemptId, reason: params.reason ?? 'CodeBuddy turn ended without a verified run completion' });
    });
  }
  async finishHarnessAttempt(params) {
    return this.mutate(params, (row, view) => {
      if (view.executionOwner !== 'harness') throw fail('Native completion requires a Harness-owned run');
      assertAttempt(view, params.attemptId);
      interruptPending(row, view);
      event(row, 'harness_attempt_finished', { attemptId: params.attemptId, ...nativeTerminal(params, view) });
    });
  }
  async recordHarnessEvent(params) {
    const native = params.event;
    if (!native || !['turn/start', 'todo/write', 'goal/change', 'subagent/start', 'subagent/end'].includes(native.type)) return { snapshot: this.get({ ...params, schemaVersion: VERSION }).snapshot };
    identity(params.nativeSessionId, 'nativeSessionId');
    if (native.type === 'todo/write' && (!Array.isArray(native.data?.todos) || native.data.todos.some((todo) => typeof todo.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(todo.status)))) throw fail('Invalid official Harness todo snapshot');
    if (native.type === 'goal/change' && (native.data?.version !== 1 || (native.data.operation !== 'clear' && !['active', 'paused', 'blocked', 'complete'].includes(native.data.goal?.phase)))) throw fail('Invalid official Harness goal snapshot');
    if (native.type.startsWith('subagent/')) { identity(native.data?.id, 'child session id'); identity(native.data?.runId, 'child run id'); }
    const nativeEventId = Number.isSafeInteger(native.seq) ? `${params.nativeSessionId}:${native.seq}` : native.type.startsWith('subagent/') ? `${params.nativeSessionId}:${native.type}:${native.data.runId}` : null;
    if (!nativeEventId) throw fail('Native projection requires an event sequence');
    return this.mutate(params, (row, view) => {
      if (view.executionOwner !== 'harness') throw fail('Native projection requires a Harness-owned run');
      assertAttempt(view, params.attemptId);
      if (row.events.some((entry) => entry.eventType === 'harness_event' && entry.payload.nativeEventId === nativeEventId)) return;
      const data = native.type.startsWith('subagent/') ? {
        id: native.data.id, runId: native.data.runId,
        ...(native.data.provider !== undefined ? { provider: native.data.provider } : {}),
        ...(native.data.local !== undefined ? { local: native.data.local } : {}),
        ...(native.data.stopReason !== undefined ? { stopReason: native.data.stopReason } : {}),
        ...(native.data.role !== undefined ? { role: native.data.role } : {}),
      } : native.data;
      event(row, 'harness_event', { nativeSessionId: params.nativeSessionId, nativeEventId, event: { type: native.type, seq: native.seq ?? null, ...(native.time !== undefined ? { time: native.time } : {}), data } });
    });
  }
  async submitPlan(params) {
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId);
      if (params.expectedPlanRevision !== view.planRevision) throw fail('Stale plan revision', -32009);
      const tasks = validatePlan(params.tasks, view.tasks);
      event(row, 'plan_submitted', { tasks });
    });
  }
  async startTask(params) {
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId); const task = taskIn(view, params.taskId);
      if (['succeeded', 'cancelled', 'skipped'].includes(task.state)) throw fail('Task is no longer executable');
      if (task.dependsOn.some((id) => taskIn(view, id).state !== 'succeeded')) throw fail('Task dependencies have not succeeded');
      if (task.state !== 'running') event(row, 'task_started', { taskId: params.taskId });
    });
  }
  async recordToolStart(params) {
    identity(params.callId, 'callId'); text(params.name, 'tool.name', 512);
    return this.mutate(params, (row, view) => {
      if (view.executionOwner === 'harness') assertAttempt(view, params.attemptId);
      else assertActing(view, params.attemptId);
      if (view.effects.some((item) => item.effectId === params.callId)) throw fail('Tool call already recorded; dispatch is not repeatable');
      if (view.executionOwner !== 'harness' && params.taskId && taskIn(view, params.taskId).state !== 'running') throw fail('Tool task must be running');
      event(row, 'tool_dispatched', { callId: params.callId, name: params.name, taskId: params.taskId ?? null, attemptId: params.attemptId, ...(params.internal === true ? { internal: true } : {}) });
    });
  }
  async recordToolResult(params) {
    if (!['succeeded', 'failed', 'unknown'].includes(params.outcome)) throw fail('Invalid host tool outcome');
    const kind = params.kind ?? 'tool';
    if (!['tool', 'read', 'write', 'command', 'verification'].includes(kind)) throw fail('Invalid host evidence kind');
    if (params.exitCode != null && !Number.isInteger(params.exitCode)) throw fail('exitCode must be an integer');
    if (params.outcome === 'succeeded' && params.exitCode != null && params.exitCode !== 0) throw fail('A nonzero exit code is not successful evidence');
    if (kind === 'verification' && (!params.command || params.exitCode == null)) throw fail('Verification evidence needs an actual command and exit code');
    return this.mutate(params, (row, view) => {
      assertAttempt(view, params.attemptId);
      const effect = view.effects.find((item) => item.effectId === params.callId);
      if (!effect || effect.attemptId !== params.attemptId || effect.state !== 'pending') throw fail('Tool receipt does not match an unresolved dispatch in this attempt');
      const internal = row.events.findLast(entry => entry.eventType === 'tool_dispatched' && entry.payload.callId === params.callId)?.payload.internal === true;
      const result = event(row, 'tool_result', { callId: params.callId, taskId: effect.taskId, outcome: params.outcome, kind, summary: params.summary ?? params.outcome, artifactRef: params.artifactRef ?? `harness-tool:${params.callId}`, command: params.command ?? null, exitCode: params.exitCode ?? null, path: params.path ?? null, ...(internal ? { internal: true } : {}) });
      return { evidenceId: result.eventId };
    });
  }
  async proposeTaskResult(params) {
    text(params.summary, 'summary', 8000);
    if (!['succeeded', 'failed'].includes(params.outcome)) throw fail('Task proposal must be succeeded or failed');
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId); const task = taskIn(view, params.taskId);
      if (task.state !== 'running') throw fail('Task must be running before submitting its result');
      if (!Array.isArray(params.evidenceIds) || !params.evidenceIds.length) throw fail('Task result requires host evidence');
      const receipts = params.evidenceIds.map((id) => view.receipts.find((item) => item.eventId === id));
      if (receipts.some((receipt) => !receipt || receipt.taskId !== task.taskId || receipt.sequence <= task.startedSequence)) throw fail('Evidence must belong to this task execution');
      if (params.outcome === 'succeeded' && receipts.some((receipt) => receipt.outcome !== 'succeeded')) throw fail('Task success requires successful host receipts');
      if (params.outcome === 'failed' && !receipts.some((receipt) => receipt.outcome === 'failed')) throw fail('Task failure requires a failed host receipt');
      if (task.kind === 'verification' && params.outcome === 'succeeded' && !receipts.some((receipt) => receipt.kind === 'verification' && receipt.exitCode === 0)) throw fail('Verification task needs a successful host verification receipt');
      if (view.effects.some((effect) => effect.taskId === task.taskId && ACTIVE_EFFECTS.has(effect.state))) throw fail('Task has pending or uncertain effects');
      event(row, 'task_result', { taskId: params.taskId, outcome: params.outcome, summary: params.summary, evidenceIds: [...new Set(params.evidenceIds)] });
    });
  }
  async proposeFinish(params) {
    text(params.summary, 'summary', 8000);
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId);
      if (unresolved(view).length) throw fail('Run has pending or uncertain effects');
      if (view.policy.requirePlan && !view.tasks.length) throw fail('Run completion requires a submitted plan');
      if (view.tasks.some((task) => task.state !== 'succeeded')) throw fail('Run contains unfinished or cancelled obligations');
      if (view.policy.requireEvidence && !view.receipts.some((item) => item.outcome === 'succeeded')) throw fail('Run completion lacks host evidence');
      const lastWrite = Math.max(0, ...view.receipts.filter((item) => item.kind === 'write' && item.outcome !== 'failed').map((item) => item.sequence));
      if (view.policy.requireVerification && !view.receipts.some((item) => item.kind === 'verification' && item.outcome === 'succeeded' && item.exitCode === 0 && item.sequence > lastWrite)) throw fail('Run completion lacks successful verification after its latest file change');
      const latestChecks = new Map(view.receipts.filter((item) => item.kind === 'verification').map((item) => [item.command, item]));
      if ([...latestChecks.values()].some((item) => item.outcome !== 'succeeded' || item.exitCode !== 0)) throw fail('A verification command still has a failed or uncertain latest result');
      if (view.agents.some((agent) => ['starting', 'running', 'stopping'].includes(agent.state))) throw fail('Run still has live workers');
      event(row, 'run_completed', { summary: params.summary });
    });
  }
  async proposeAnswer(params) {
    text(params.answer, 'answer');
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId);
      if (view.planRevision || view.tasks.length || view.effects.length || view.receipts.length || view.agents.length) throw fail('Response-only completion cannot replace an existing project plan, execution or evidence');
      // The model explicitly proposes an answer. Host facts constrain that
      // proposal; neither text matching nor end_turn classifies the request.
      event(row, 'response_completed', { answer: params.answer });
    });
  }
  async reportBlocked(params) {
    text(params.reason, 'reason', 8000);
    if (!['user', 'environment'].includes(params.kind)) throw fail('Unknown blocker kind');
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId);
      event(row, 'run_blocked', { reason: params.reason, kind: params.kind });
    });
  }
  async workerStarted(params) {
    if (!['planner', 'coder', 'tester', 'reviewer'].includes(params.role)) throw fail('Invalid worker role');
    identity(params.agentId, 'agentId');
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId);
      if (view.agents.some((agent) => agent.agentId === params.agentId)) throw fail('Worker identity already used');
      if (params.taskId) taskIn(view, params.taskId);
      event(row, 'worker_started', { agentId: params.agentId, taskId: params.taskId ?? null, role: params.role });
    });
  }
  async workerStopped(params) {
    return this.mutate(params, (row, view) => {
      if (!view.agents.some((agent) => agent.agentId === params.agentId)) throw fail('Worker not found');
      event(row, 'worker_stopped', { agentId: params.agentId, crashed: params.crashed === true });
    });
  }
  async workerTaskAssigned(params) {
    identity(params.agentId, 'agentId');
    if (params.taskId != null) identity(params.taskId, 'taskId');
    return this.mutate(params, (row, view) => {
      assertActing(view, params.attemptId);
      const agent = view.agents.find((item) => item.agentId === params.agentId);
      if (!agent || agent.state !== 'running') throw fail('Task ownership requires a live worker');
      if (params.taskId != null) {
        if (taskIn(view, params.taskId).state !== 'running') throw fail('Worker can only own a running task');
        if (view.agents.some((item) => item.agentId !== params.agentId && item.state === 'running' && item.taskId === params.taskId)) throw fail('Task already has a live worker owner');
      }
      if (agent.taskId !== (params.taskId ?? null)) event(row, 'worker_task_assigned', { agentId: params.agentId, taskId: params.taskId ?? null });
    });
  }
  async control(params) {
    protocol(params); identity(params.commandId, 'commandId');
    const action = params.action;
    if (!action || !['pause_run', 'resume_run', 'emergency_stop', 'stop_worker', 'cancel_task', 'cancel_branch'].includes(action.type)) throw fail('Unknown run control action');
    if (action.type !== 'resume_run') text(action.reason, 'reason', 8000);
    const prepared = await this.store.update((state) => {
      const row = rowIn(state, params); const view = project(row);
      const saved = row.commands.find((command) => command.commandId === params.commandId);
      if (saved) {
        if (!same(saved.action, action)) throw fail('commandId was already used for a different action');
        if (!saved.response) throw fail('Control command is awaiting execution acknowledgement', -32009);
        return { replay: saved.response };
      }
      if (params.expectedSequence !== undefined && params.expectedSequence !== row.events.length) throw fail('Stale run sequence; refresh the run before retrying', -32009);
      assertMutable(view);
      if (view.executionOwner === 'harness') {
        if (action.type === 'cancel_task' || action.type === 'cancel_branch') throw fail('Harness todo entries are presentation snapshots and do not support task or branch cancellation');
        if (action.type === 'stop_worker') throw fail('Stopping a Harness worker requires native worker control; root execution was not stopped');
      }
      if (action.type === 'resume_run') {
        if (view.state !== 'paused' || view.activeAttempt) throw fail('Only a quiescent paused run can resume');
        if (view.executionOwner !== 'harness' && unresolved(view).length) throw fail('Resolve uncertain effects before resuming');
        if (!this.onResume) throw fail('Harness resume callback is not connected');
      } else {
        if (view.activeAttempt && !this.onCancel) throw fail('Harness cancellation callback is not connected');
        if (action.type === 'stop_worker' && !view.agents.some((agent) => agent.agentId === action.agentId && ['starting', 'running', 'stopping'].includes(agent.state))) throw fail('Live worker not found');
        if (action.type === 'cancel_task') taskIn(view, action.taskId);
        if (action.type === 'cancel_branch') taskIn(view, action.rootTaskId);
      }
      const previousSequence = row.events.length;
      row.commands.push({ commandId: params.commandId, action: copy(action), previousSequence });
      event(row, action.type === 'resume_run' ? 'run_resumed' : 'pause_requested', { reason: action.reason ?? 'User resumed execution', commandId: params.commandId });
      return { row: copy(row), previousSequence, activeAttempt: view.activeAttempt };
    }, ['codeproRuns']);
    if (prepared.replay) return prepared.replay;
    this.publish(prepared.row, prepared.previousSequence);
    if (action.type !== 'resume_run' && this.onCancel) {
      try { await this.onCancel({ sessionId: params.sessionId, runId: params.runId, attemptId: prepared.activeAttempt, action }); }
      catch (error) {
        // Preserve the stop request and unresolved effects; a failed callback is
        // not evidence that the process or tool actually stopped.
        throw fail(`Harness did not acknowledge stopping: ${error.message}`, -32010);
      }
    }
    const committed = await this.store.update((state) => {
      const row = rowIn(state, params); const view = project(row);
      if (action.type !== 'resume_run') {
        if (view.activeAttempt) {
          interruptPending(row, view);
          event(row, 'attempt_finished', { attemptId: view.activeAttempt, reason: action.reason });
        }
        if (action.type === 'emergency_stop') event(row, 'run_cancelled', { reason: action.reason });
        if (action.type === 'stop_worker') event(row, 'worker_stopped', { agentId: action.agentId, crashed: false });
        if (action.type === 'cancel_task' || action.type === 'cancel_branch') {
          const taskIds = new Set([action.taskId ?? action.rootTaskId]);
          if (action.type === 'cancel_branch') {
            for (let changed = true; changed;) {
              changed = false;
              for (const task of view.tasks) if (!taskIds.has(task.taskId) && task.dependsOn.some((dependency) => taskIds.has(dependency))) { taskIds.add(task.taskId); changed = true; }
            }
          }
          event(row, 'tasks_cancelled', { taskIds: [...taskIds], reason: action.reason });
        }
      }
      const response = { commandId: params.commandId, previousSequence: prepared.previousSequence, committedEventIds: row.events.slice(prepared.previousSequence).map((entry) => entry.eventId), snapshot: snapshot(row) };
      row.commands.find((command) => command.commandId === params.commandId).response = copy(response);
      return { row: copy(row), response };
    }, ['codeproRuns']);
    this.publish(committed.row, prepared.row.events.length);
    if (action.type === 'resume_run') queueMicrotask(() => {
      Promise.resolve().then(() => this.onResume({ sessionId: params.sessionId, runId: params.runId, context: this.context(params) })).catch(() => this.mutate(params, (row, view) => {
        if (view.state === 'recovering' && !view.activeAttempt) event(row, 'pause_requested', { reason: 'Harness resume failed before execution began' });
      })).catch(() => {});
    });
    return committed.response;
  }
  async resolveEffect(params) {
    protocol(params);
    if (!['confirmed_applied', 'confirmed_not_applied'].includes(params.resolution)) throw fail('Invalid effect resolution');
    return this.mutate(params, (row, view) => {
      if (view.activeAttempt) throw fail('Wait for the active attempt to stop before resolving effects');
      const effect = view.effects.find((item) => item.effectId === params.effectId);
      if (!effect?.requiresResolution) throw fail('Effect is not awaiting resolution');
      event(row, 'effect_resolved', { effectId: params.effectId, resolution: params.resolution });
    });
  }
  planContext(params) {
    const row = rowIn(this.store.read(['codeproRuns']), key(params)); const view = project(row);
    const binding = { session_id: row.sessionId, run_id: row.runId, requirement_revision: view.planRevision };
    return { type: 'codepro_plan_context', schema_version: 1, event_id: `plan:${row.runId}:${row.events.length}`, session_id: row.sessionId, selected: binding,
      plan: view.tasks.length ? { binding, content: view.tasks.map((task) => `${task.state === 'succeeded' ? '[x]' : task.state === 'running' ? '[-]' : '[ ]'} ${task.name}`).join('\n'), request_id: `plan:${row.runId}:${view.planRevision}` } : null };
  }
}
