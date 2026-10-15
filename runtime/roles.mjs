import { driverProvider, invalid, providerStatus, requireString } from './providers.mjs';

export const CODEPRO_ROLES = Object.freeze(['main', 'planner', 'coder', 'tester', 'reviewer']);
const workerRoles = CODEPRO_ROLES.slice(1);
const spawnRoles = new Map(workerRoles.map(role => [`subagent_${role}`, role]));
const childActions = new Set(['inspect', 'start_task', 'task_result']);

function coderLimit(value = 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw invalid('Maximum parallel coders must be between 1 and 32');
  return value;
}

// The saved routing config selects providers. Provider conversion remains with
// the existing credential owner; this module never persists decrypted settings.
export async function resolveRoleRouting({ config, session, providers, resolveProvider = driverProvider, thinkingEffort }) {
  if (config && (![1, 2].includes(config.version) || typeof config.advancedRoutingEnabled !== 'boolean')) throw invalid('Invalid model routing configuration');
  const maxParallelCoders = coderLimit(config?.maxParallelCoders);
  const routes = new Map();
  if (config?.advancedRoutingEnabled) {
    if (!Array.isArray(config.routes)) throw invalid('Role routes must be an array');
    for (const route of config.routes) {
      if (!CODEPRO_ROLES.includes(route.role) || routes.has(route.role)) throw invalid('Unknown or duplicate model routing role');
      routes.set(route.role, route);
    }
    if (CODEPRO_ROLES.some(role => !routes.has(role))) throw invalid('Enabled routing requires all five roles');
  }
  const converted = new Map();
  async function selection(role) {
    const route = routes.get(role) ?? session;
    const providerId = requireString(route.providerId, 'providerId');
    const model = requireString(route.modelId, 'modelId');
    const provider = providers.find(item => item.id === providerId);
    if (!provider || !provider.models.includes(model) || !providerStatus(provider).isConfigured) throw invalid(`Configure the selected ${role} model first`);
    const key = JSON.stringify([providerId, model]);
    if (!converted.has(key)) converted.set(key, Promise.resolve(resolveProvider(provider, model)));
    return { provider: await converted.get(key), model, ...(thinkingEffort != null ? { thinkingEffort } : {}) };
  }
  const main = await selection('main');
  const roleModels = Object.fromEntries(await Promise.all(workerRoles.map(async role => [role, await selection(role)])));
  return { main, roleModels, maxParallelCoders };
}

// One instance belongs to one live Harness attempt. Durable worker and task
// facts remain in CodeProRuns; these maps only arbitrate actual live ownership.
export class CodeProRoleRuntime {
  constructor({ binding, runs, maxParallelCoders = 1, taskIds = new Map() }) {
    this.binding = { ...binding };
    this.runs = runs;
    this.maxParallelCoders = coderLimit(maxParallelCoders);
    this.taskIds = taskIds;
    this.pending = new Map();
    this.workers = new Map();
    this.actors = new Map();
    this.spawnCalls = new Map();
    this.actions = Promise.resolve();
  }

  actor(sessionId) {
    if (sessionId === this.binding.sessionId) return { role: 'main', sessionId };
    const worker = this.actors.get(sessionId);
    if (!worker || worker.state !== 'running') throw invalid('Unknown or inactive CodePro worker');
    return worker;
  }

  assertToolActor(sessionId) {
    const actor = this.actor(sessionId);
    const taskId = this.taskIds.get(sessionId);
    if (actor.role !== 'main' && !taskId) throw invalid('Worker must start an existing planned task before executing tools');
    return taskId;
  }

  reserveSpawn(tool) {
    if (tool.name === 'subagent') throw invalid('Use the configured CodePro role subagent tools');
    // send_message may reactivate a stopped Harness child without a role
    // dispatch. Admit that lifecycle only once explicit continuation ownership
    // is implemented; user steering currently continues the root session.
    if (tool.name === 'send_message') throw invalid('CodePro worker continuation is not configured; continue through the main agent');
    const role = spawnRoles.get(tool.name);
    if (!role) return null;
    const sessionId = requireString(tool.sessionId ?? this.binding.sessionId, 'sessionId');
    const callId = requireString(tool.id ?? tool.callId, 'callId');
    this.actor(sessionId);
    const key = JSON.stringify([sessionId, callId]);
    if (this.spawnCalls.has(key)) throw invalid('A subagent dispatch cannot be replayed');
    // Harness lifecycle events identify the direct parent but not the issuing
    // call. A single unbound dispatch per parent gives an exact association.
    if (this.pending.has(sessionId)) throw invalid('Wait for the preceding subagent activation before another spawn');
    const activeCoders = [...this.workers.values()].filter(worker => worker.role === 'coder' && worker.state !== 'stopped').length;
    const pendingCoders = [...this.pending.values()].filter(reservation => reservation.role === 'coder').length;
    if (role === 'coder' && activeCoders + pendingCoders >= this.maxParallelCoders) throw invalid('Maximum parallel coders reached');
    const reservation = { sessionId, callId, role, key, state: 'pending' };
    this.pending.set(sessionId, reservation);
    this.spawnCalls.set(key, reservation);
    return { sessionId, callId, role };
  }

  async workerStarted(event) {
    const parentId = requireString(event.sessionId, 'parent sessionId');
    const childId = requireString(event.childSessionId ?? event.id, 'childSessionId');
    const activationId = requireString(event.runId, 'activation runId');
    if (event.local !== true) throw invalid('CodePro worker requires an observed local Harness agent');
    if (this.workers.has(activationId)) throw invalid('Worker activation was already observed');
    const reservation = this.pending.get(parentId);
    if (!reservation) throw invalid('Worker activation has no admitted role dispatch');
    if (this.actors.get(childId)?.state === 'running') throw invalid('Worker already has a live activation');
    const worker = { sessionId: childId, parentId, agentId: activationId, role: reservation.role, state: 'starting', callId: reservation.callId };
    this.pending.delete(parentId);
    this.workers.set(activationId, worker);
    this.actors.set(childId, worker);
    Object.assign(reservation, { state: 'activated', childId, activationId });
    // Keep the reservation counted if durable recording fails. A bookkeeping
    // error is not evidence that the actual child has stopped.
    await this.runs.workerStarted({ ...this.binding, agentId: activationId, role: worker.role });
    worker.state = 'running';
    return { ...worker };
  }

  async workerStopped(event) {
    const activationId = requireString(event.runId, 'activation runId');
    const childId = requireString(event.childSessionId ?? event.id, 'childSessionId');
    const worker = this.workers.get(activationId);
    if (!worker || worker.sessionId !== childId) throw invalid('Worker stop does not match an observed activation');
    if (worker.state === 'stopped') return;
    await this.runs.workerStopped({ ...this.binding, agentId: activationId, crashed: event.stopReason === 'error' });
    worker.state = 'stopped';
    this.taskIds.delete(childId);
  }

  settleSpawn({ sessionId = this.binding.sessionId, callId, subagentId, failed = false }) {
    const reservation = this.spawnCalls.get(JSON.stringify([sessionId, callId]));
    if (!reservation) return;
    if (reservation.state === 'pending') {
      if (!failed) throw invalid('Successful spawn lacks the actual worker start event');
      if (this.pending.get(sessionId) === reservation) this.pending.delete(sessionId);
      reservation.state = 'failed';
      return;
    }
    if (!failed && subagentId !== reservation.childId) throw invalid('Subagent result identity differs from its actual activation');
    // A tool result only acknowledges activation. Only workerStopped releases
    // capacity, even if the spawning tool itself reports a later error.
  }

  childSessionFor(agentId) {
    const worker = this.workers.get(agentId);
    return worker && worker.state !== 'stopped' ? worker.sessionId : null;
  }

  taskAction(sessionId, args, operation) {
    const result = this.actions.then(async () => {
      const actor = this.actor(sessionId);
      if (actor.role !== 'main' && !childActions.has(args.action)) throw invalid('Only the main agent may change the plan or global run state');
      if (args.action === 'start_task' || args.action === 'task_result') {
        const context = this.runs.context(this.binding);
        if (!context.tasks.some(task => task.taskId === args.taskId)) throw invalid('Worker task must already exist in the current plan');
        const owner = [...this.taskIds.entries()].find(([, taskId]) => taskId === args.taskId)?.[0];
        if (owner && owner !== sessionId) throw invalid('Task belongs to another active agent');
        if (args.action === 'start_task' && this.taskIds.has(sessionId) && this.taskIds.get(sessionId) !== args.taskId) throw invalid('Finish the currently owned task before starting another');
        if (args.action === 'task_result' && owner !== sessionId) throw invalid('Agent must own a task before proposing its result');
      }
      const value = await operation();
      if (args.action === 'start_task') this.taskIds.set(sessionId, args.taskId);
      if (args.action === 'task_result') this.taskIds.delete(sessionId);
      if (actor.role !== 'main' && ['start_task', 'task_result'].includes(args.action)) await this.runs.workerTaskAssigned({ ...this.binding, agentId: actor.agentId, taskId: this.taskIds.get(sessionId) ?? null });
      return value;
    });
    this.actions = result.catch(() => {});
    return result;
  }
}
