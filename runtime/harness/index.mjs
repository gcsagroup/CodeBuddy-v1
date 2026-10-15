import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { boot } from '@deepseek-ai/dsh-app-boot';
import compactionPlugin from './compaction.mjs';
import * as mcpPlugin from './mcp-bridge.mjs';
import * as subagentToolPlugin from '@deepseek-ai/dsh-tool-subagent';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope';
import { z } from 'zod';
import { profileEntries } from './profile.mjs';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKENS } from '../model-defaults.mjs';
import { forkWorkingDirectory } from './working-directory.mjs';
import { observeModelTransport } from './transport-observation.mjs';
import { createMcpPresets, restrictSessionTools } from './mcp-presets.mjs';

export const HARNESS_VERSION = '0.2.1-alpha.2';
export const HARNESS_REFERENCE_COMMIT = 'd743267388641bc76f17c45ce8b4c231aed1d32c';

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'));
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Boot the official Harness Host and expose the existing CodeBuddy transport seam. */
export async function createHarnessDriver({ dataDir, cwd = process.cwd(), instructionsHome } = {}) {
  if (!dataDir) throw new TypeError('Harness dataDir is required for old/new data isolation');
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true });
  const configPath = join(root, 'codebuddy-host.json');
  await writeFile(configPath, JSON.stringify(profileEntries(root, resolve(cwd), resolve(instructionsHome ?? root)), null, 2));
  const runs = new Map();
  const maintenanceRuns = new Map();
  const credentials = new Map();
  const routes = new Map();
  const providers = new Map();
  const sessionSettings = new Map();
  const sessionScopes = new Map();
  const directCalls = new Map();
  const toolReceipts = new Map();
  const configurationQueues = new Map();
  const extensionStates = new Map();
  const childOwners = new Map();
  const mcpBindings = new WeakMap();
  let skillRefresh = Promise.resolve();
  let subagentConfiguration = Promise.resolve();
  let subagentCapacity = 4;
  let selection = { provider: 'codebuddy-unconfigured', model: 'unconfigured' };
  const ctx = await boot('codebuddy-harness', configPath, [], host => {
    host.provide('agentDefaultModel', {
      currentSelection: () => ({ ...selection }),
      saveSelection: async next => { selection = { ...next }; },
    });
    host.provide('launchEnvironment', {
      get: name => credentials.has(name) ? { value: credentials.get(name), source: 'process' } : undefined,
      getFrom: (name, sources) => sources.includes('process') && credentials.has(name) ? { value: credentials.get(name), source: 'process' } : undefined,
    });
    // The ACP surface owns listening/authentication. Official FileUploads binds
    // its HTTP handler here; callers may delegate authenticated upload requests.
    host.provide('connection', { fetch: { register(route) {
      if (routes.has(route.path)) throw new Error(`Duplicate upload route: ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } } });
  }, fileURLToPath(new URL('./', import.meta.url)));
  const inactive = [...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber?.state !== 2);
  if (inactive.length) {
    await ctx.fiber.dispose();
    throw new Error(`Harness profile did not fully activate: ${inactive.map(entry => entry.id).join(', ')}`);
  }
  for (const service of ['agentLoop', 'sessionController', 'fileUploads', 'fs', 'tools', 'sessionPersistence']) {
    if (!ctx.get(service)) { await ctx.fiber.dispose(); throw new Error(`Harness required service did not activate: ${service}`); }
  }
  const mcpPresets = await createMcpPresets(ctx);

  function runFor(agent) {
    if (!agent) return undefined;
    // Durable lineage only locates a candidate; the registry verifies live ownership.
    for (let current = agent; current;) {
      const active = runs.get(current.id) ?? maintenanceRuns.get(current.id);
      if (active) return active;
      const parent = ctx.agents.get(current.session.header.parentSession);
      current = parent && ctx.agents.isOwnedBy(current.id, parent) ? parent : undefined;
    }
    return undefined;
  }
  function settingsFor(agent) {
    for (let current = agent; current;) {
      if (sessionSettings.has(current.id)) return sessionSettings.get(current.id);
      const parent = ctx.agents.get(current.session.header.parentSession);
      current = parent && ctx.agents.isOwnedBy(current.id, parent) ? parent : undefined;
    }
    return undefined;
  }
  // Resolve against the executing Agent, including children and sessions that
  // share a standing MCP connection. Routing never belongs to the connection.
  ctx.provide('codebuddyMcpRequestMetadata', {
    get(serverName, exec) {
      return settingsFor(exec.agent)?.mcpRequestMetadata?.(serverName);
    },
  });
  ctx.provide('codebuddyMcpVision', {
    async project(content, exec) {
      const routed = exec.agent?.session.requestHeader()?.config;
      const provider = routed?.provider ?? exec.agent?.options.provider;
      const model = routed?.model ?? exec.agent?.options.model;
      const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal);
      if (info.inputModalities?.includes('image')) return content;
      const fallback = settingsFor(exec.agent)?.mcpImageFallback;
      if (!fallback) return content;
      return fallback(content, { sessionId: exec.agent.id, toolName: exec.name, signal: exec.signal });
    },
  });
  function emit(run, event) {
    if (!run) return;
    run.events = run.events.then(() => run.onEvent?.(event));
    run.events.catch(error => { run.error = error; run.reject(error); });
  }
  function contextUsage(session) {
    const snapshot = ctx.sessionProjections.snapshot(session, ['tokenUsage', 'contextPressure']);
    const meter = ctx.tokenMeter.measure(session);
    const usage = snapshot.values.tokenUsage;
    const pressure = snapshot.values.contextPressure;
    return {
      type: 'context_usage', sessionId: session.id, revision: meter.logRevision,
      used: meter.totalTokens, contextLimit: pressure?.contextWindow,
      // Occupancy includes estimated changes since the provider anchor; it is
      // not a live billing counter and does not include uncommitted stream text.
      source: meter.baseline.kind === 'usage' && meter.surfaceDeltaTokens === 0 ? 'provider_actual' : 'local_estimate',
      accumulatedInputTokens: (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0),
      accumulatedOutputTokens: usage?.outputTokens ?? 0,
    };
  }
  function settleRun(agent) {
    const run = agent && runs.get(agent.id);
    if (!run?.lastResult || agent.status !== 'idle') return;
    if (run.settlement) { run.settleRequested = true; return; }
    run.settlement = (async () => {
      await agent.whenIdle();
      // A child reply may wake the parent and create or change its native goal.
      while (await ctx.subagents.waitForChildren(agent)) await agent.whenIdle();
      const goal = ctx.goals.get(agent);
      // The official round driver admits another round only after idle + flush.
      // Keep this transport open while it owns continuation; never schedule here.
      if (!run.cancelRequested && !run.limitReached && goal?.phase === 'active' && goal.activation === 'armed') return;
      run.resolve({ ...run.lastResult, ...(goal ? { goal } : {}) });
    })();
    run.settlement.catch(error => { run.error = error; run.reject(error); }).finally(() => {
      run.settlement = undefined;
      if (run.settleRequested) { run.settleRequested = false; settleRun(agent); }
    });
  }
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') settleRun(agent); });
  ctx.on('goal/activation-changed', ({ sessionId }) => settleRun(ctx.agents.get(sessionId)));
  ctx.on('goal/changed', ({ agent }) => settleRun(agent));
  ctx.effect(() => observeModelTransport(ctx, event => {
    const run = runFor(ctx.agents.get(event.sessionId));
    emit(run, event);
    console.warn('[Harness model transport]', JSON.stringify(event));
  }), 'CodeBuddy model transport observation');
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return;
    const parent = ctx.agents.get(agent.session.header.parentSession);
    if (!parent || !ctx.agents.isOwnedBy(agent.id, parent)) return;
    const inherited = settingsFor(parent);
    if (!inherited) return;
    // Spawn intentionally creates a flat upstream scope. Install this host's
    // selected capabilities before its loop starts; preserve the child route's
    // own reasoning choice instead of overwriting it with its parent's choice.
    const { thinkingEffort: _parentEffort, maxParallelSubagents: _parentCapacity, ...capabilities } = inherited;
    await applySessionOptions(agent.id, capabilities, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return;
    sessionSettings.delete(agent.id);
    sessionScopes.delete(agent.id);
    extensionStates.delete(agent.id);
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    const active = directCalls.get(exec.callId) ?? runFor(exec.agent);
    if (!active?.onPermission) return { kind: 'deny', reason: 'CodeBuddy tool approval is required.' };
    try {
      await abortable(active.events, exec.signal);
      const accepted = await abortable(active.onPermission({ id: exec.callId, name: exec.name, arguments: exec.arguments, sessionId: exec.agent?.id, signal: exec.signal }), exec.signal);
      if (exec.signal.aborted) return { kind: 'cancel' };
      return accepted === true ? next() : { kind: 'deny', reason: 'Tool execution was declined.' };
    } catch (error) {
      if (exec.signal.aborted) return { kind: 'cancel' };
      return { kind: 'deny', reason: 'Tool approval did not complete.' };
    }
  });
  ctx.on('tools/result', (exec, result) => {
    const metadata = mcpPlugin.takeMcpResultMetadata(exec, result);
    const receipt = { name: exec.name, arguments: exec.arguments, structuredContent: result.value, error: result.error, ...metadata };
    const direct = directCalls.get(exec.callId);
    if (direct) direct.receipt = receipt;
    else if (runFor(exec.agent)) toolReceipts.set(`${exec.agent.id}\0${exec.callId}`, receipt);
  });
  ctx.on('subagent/start', info => {
    const child = ctx.agents.get(info.id);
    const run = runFor(child);
    if (run) {
      childOwners.set(info.id, run);
      emit(run, { type: 'subagent_start', ...info, sessionId: child.session.header.parentSession, childSessionId: info.id });
    }
  });
  ctx.on('subagent/end', info => {
    const run = childOwners.get(info.id);
    if (run) emit(run, { type: 'subagent_end', ...info, sessionId: run.sessionId, childSessionId: info.id });
    childOwners.delete(info.id);
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const run = runFor(agent);
    if (!run) return;
    if (frame.type === 'start') {
      emit(run, { type: 'assistant_start', attemptId: frame.attemptId, turn: frame.turn, step: frame.step, sessionId: agent.id });
      return;
    }
    if (frame.type !== 'chunk') return;
    const chunk = frame.chunk;
    if (chunk.type === 'text-delta') emit(run, { type: 'text_delta', text: chunk.text, attemptId: frame.attemptId, sessionId: agent.id });
    if (chunk.type === 'reasoning-delta') emit(run, { type: 'thinking_delta', text: chunk.text, attemptId: frame.attemptId, sessionId: agent.id });
    if (chunk.type === 'usage') emit(run, { type: 'usage', ...chunk.usage, sessionId: agent.id });
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      let args = chunk.block.arguments;
      try { args = JSON.parse(args); } catch { /* Preserve invalid upstream args for error display. */ }
      const metadata = mcpPlugin.getMcpToolMetadata(ctx, agent, chunk.block.name);
      emit(run, { type: 'tool_call', id: chunk.block.id, name: chunk.block.name, arguments: args, attemptId: frame.attemptId, sessionId: agent.id, ...(metadata?.mcpApp ? { mcpApp: metadata.mcpApp } : {}) });
    }
  });
  ctx.on('session/event', (session, event) => {
    const run = runFor(ctx.agents.get(session.id));
    if (!run) return;
    if (event.type === 'user/message' && event.data.source?.kind === 'skill-invocation') {
      emit(run, { type: 'skill_loaded', name: event.data.source.name, seq: event.seq, sessionId: session.id });
    }
    if (event.type === 'tool/result') {
      const msg = event.data.message;
      const receiptKey = `${session.id}\0${msg.toolCallId}`;
      const receipt = toolReceipts.get(receiptKey);
      toolReceipts.delete(receiptKey);
      emit(run, { type: 'tool_result', id: msg.toolCallId, result: msg.content, isError: msg.isError, messageId: msg.id, sessionId: session.id, ...receipt });
    }
    if (event.type === 'assistant/message') emit(run, { type: 'assistant_committed', messageId: event.data.message.id, seq: event.seq, sessionId: session.id });
    if (event.type === 'turn/start' || event.type === 'todo/write' || event.type === 'goal/change' || event.type.startsWith('llm/retry') || event.type.startsWith('compaction/') || event.type.startsWith('subagent/')) emit(run, { type: 'harness_event', event, sessionId: session.id });
    if (['request/context', 'user/message', 'assistant/message', 'tool/result', 'compaction/end'].includes(event.type))
      emit(run, contextUsage(session));
    if (event.type === 'turn/end' && runs.get(session.id) === run) {
      const reason = event.data.reason;
      if (reason.kind === 'error') { run.error = Object.assign(new Error(reason.error.message), { code: reason.error.code }); run.reject(run.error); }
      else {
        const stopReason = run.limitReached ? 'max_turns' : ({ completed: 'end_turn', aborted: 'cancelled', interrupted: 'cancelled', 'max-tokens': 'max_tokens', blocked: 'refusal' })[reason.kind];
        if (stopReason) { run.lastResult = { stopReason, reason, ...(run.limitReached ? { limit: run.limitReached } : {}) }; settleRun(ctx.agents.get(session.id)); }
        else { run.error = new Error(`Harness turn ended without completion: ${reason.kind}`); run.reject(run.error); }
      }
    }
  });
  ctx.on('agent/error', ({ agent, error }) => runs.get(agent.id)?.reject(error));
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const run = runFor(agent);
    const limit = settingsFor(agent)?.maxTurns;
    if (run && limit && run.steps >= limit) {
      run.limitReached = limit;
      agent.cancel({ kind: 'hook', reason: 'codebuddy:max-turns' });
      cancelChildren(run.sessionId);
      return { kind: 'reject' };
    }
    if (run) run.steps += 1;
    return next();
  });
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = { ...await next() };
    const settings = settingsFor(agent);
    if (!settings) return config;
    if (settings.maxTokens !== undefined) config.maxTokens = settings.maxTokens;
    if (settings.temperature !== undefined) config.temperature = settings.temperature;
    if (sessionSettings.has(agent.id) && settings.thinkingEffort !== undefined) config.reasoningEffort = settings.thinkingEffort;
    return config;
  });

  let creation = Promise.resolve();
  let providerConfiguration = Promise.resolve();
  function configureProvider(provider, model) {
    const work = providerConfiguration.then(() => configureProviderNow(provider, model));
    providerConfiguration = work.catch(() => {});
    return work;
  }
  async function configureProviderNow(provider, model) {
    if (!provider || typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) throw new Error('Configure a model endpoint before starting a Harness session.');
    if (typeof model !== 'string' || !model.trim()) throw new Error('A model id is required.');
    const protocol = provider.protocol ?? 'openai-completions';
    const digest = createHash('sha256').update(JSON.stringify({ ...provider, model })).digest('hex').slice(0, 20);
    const route = `codebuddy-${digest}`;
    if (!providers.has(route)) {
      const keyRef = `CODEBUDDY_MODEL_${digest}`;
      // Always explicit: never let pi-ai fall through to ambient API credentials.
      credentials.set(keyRef, provider.apiKey || 'codebuddy-no-key');
      const profile = {
        api: protocol,
        baseURL: provider.baseUrl,
        apiKeyEnv: keyRef,
        // Omission uses the official provider policy and the official retry plugin.
        ...(provider.retryPolicy ? { retryPolicy: provider.retryPolicy } : {}),
        models: [{ id: model, contextWindow: provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxTokens: provider.maxTokens ?? DEFAULT_OUTPUT_TOKENS, input: provider.inputModalities ?? ['text'], ...(provider.reasoningEfforts !== undefined ? { reasoningEfforts: provider.reasoningEfforts } : {}) }],
        ...(provider.compat ? { compat: provider.compat } : {}),
        ...(provider.headers ? { headers: provider.headers } : {}),
      };
      const next = new Map(providers);
      next.set(route, profile);
      const entry = [...ctx.loader.entries()].find(item => item.options.id === 'llm-pi-ai');
      // Entry.update handles this volatile field in memory. Loader.update or
      // Fiber.update may persist options and must not receive secret headers.
      await entry.update({ config: { providers: Object.fromEntries(next) } });
      await ctx.loader.await();
      // Prove the requested route is serving after the official volatile update.
      await ctx.llm.resolveModelInfo(route, model);
      providers.set(route, profile);
    }
    return { provider: route, model };
  }
  async function resolveAgent(sessionId) {
    const found = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in found) throw found.error;
    return found.agent;
  }
  function cancelChildren(sessionId) {
    const parent = ctx.agents.get(sessionId);
    if (!parent || !runs.has(sessionId)) return;
    const run = runs.get(sessionId);
    const settling = [];
    for (const child of ctx.agents.list()) {
      if (child.id !== sessionId && runFor(child) !== run) continue;
      ctx.goals.disarm(child);
      if (child.id !== sessionId) ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent });
      for (const job of ctx.jobs.list(child.id)) {
        if (!['running', 'stopping'].includes(job.status)) continue;
        ctx.jobs.kill(job.id, child.id, 'CodeBuddy prompt cancelled');
        settling.push(ctx.jobs.wait(job.id, 5000, child.id));
      }
    }
    run.jobSettlement = Promise.all(settling);
    run.jobSettlement.catch(error => { run.error = error; run.reject(error); });
  }
  const memoryDomain = await ctx.storage.domain.open(defineDomain({
    name: 'codebuddy_memory', version: 1,
    tables: { records: domainTable(z.object({ scope: z.string().min(1), key: z.string().min(1), value: z.json() })) },
  }));
  const memoryRecords = memoryDomain.table('records');
  function memoryKey(scope, key) {
    if (typeof scope !== 'string' || !scope || typeof key !== 'string' || !key) throw new TypeError('Memory scope and key are required');
    return createHash('sha256').update(JSON.stringify([scope, key])).digest('hex');
  }
  function configureSession(sessionId, options = {}) {
    const work = (configurationQueues.get(sessionId) ?? Promise.resolve()).then(() => applySessionOptions(sessionId, options));
    configurationQueues.set(sessionId, work.catch(() => {}));
    return work;
  }
  async function applySessionOptions(sessionId, options, createdAgent) {
    const agent = createdAgent ?? await resolveAgent(sessionId);
    if (agent.status !== 'idle' || runs.has(sessionId)) throw new Error('Session settings can only change while idle');
    const previous = sessionSettings.get(sessionId) ?? {};
    const settings = { ...previous, ...options };
    if (settings.maxParallelSubagents !== undefined) {
      const capacity = settings.maxParallelSubagents;
      if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32) throw new TypeError('maxParallelSubagents must be between 1 and 32');
      const update = subagentConfiguration.then(async () => {
        if (capacity === subagentCapacity) return;
        const entry = [...ctx.loader.entries()].find(item => item.options.id === 'subagents');
        // The official service reads this volatile cap at future admission.
        // Already-running children are neither evicted nor recreated.
        await entry.update({ config: { ...entry.options.config, maxActiveSubagents: capacity } });
        await ctx.loader.await();
        subagentCapacity = capacity;
      });
      subagentConfiguration = update.catch(() => {});
      await update;
    }
    for (const field of ['maxTurns', 'maxTokens']) if (settings[field] !== undefined && (!Number.isSafeInteger(settings[field]) || settings[field] < 1)) throw new TypeError(`${field} must be a positive integer`);
    if (settings.temperature !== undefined && (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2)) throw new TypeError('temperature must be between 0 and 2');
    if (settings.autoCompactThreshold !== undefined && (!Number.isFinite(settings.autoCompactThreshold) || settings.autoCompactThreshold <= 0 || settings.autoCompactThreshold >= 1)) throw new TypeError('autoCompactThreshold must be between 0 and 1');
    if (settings.systemPrompt !== undefined && typeof settings.systemPrompt !== 'string') throw new TypeError('systemPrompt must be text');
    const mcpServers = settings.mcpServers ?? [];
    const names = new Set();
    for (const server of mcpServers) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName) || names.has(server.serverName)) throw new TypeError('MCP server names must be unique valid identifiers');
      names.add(server.serverName);
    }
    for (const tool of settings.tools ?? []) {
      if (!tool.name || typeof tool.execute !== 'function') throw new TypeError('Host tools require name and execute');
    }
    const roleModels = [];
    for (const [role, route] of Object.entries(settings.roleModels ?? {})) {
      if (!['planner', 'coder', 'tester', 'reviewer'].includes(role)) throw new TypeError(`Unknown subagent role: ${role}`);
      roleModels.push({ role, selection: { ...await configureProvider(route.provider, route.model), ...(route.thinkingEffort ? { reasoningEffort: route.thinkingEffort } : {}) } });
    }
    await sessionScopes.get(sessionId)?.dispose();
    sessionScopes.delete(sessionId);
    sessionSettings.delete(sessionId);
    const connections = [];
    const remoteServers = mcpServers.filter(server => server.transport === 'streamable-http');
    const shared = await mcpPresets.acquire(remoteServers);
    let binding = mcpBindings.get(agent);
    if (shared) {
      if (binding) binding.rebind(shared.key);
      else { binding = bindScopeParent(agent, shared.key); mcpBindings.set(agent, binding); }
      connections.push(...shared.statuses);
      console.info('[Harness MCP reuse]', JSON.stringify({ sessionId, reused: shared.reused, servers: shared.statuses.length }));
    }
    const fiber = agent.ctx.isolate('compaction').plugin({
      name: 'codebuddy-session-capabilities',
      async apply(scoped) {
        if (shared) scoped.effect(() => async () => {
          binding.rebind(undefined);
          await shared[Symbol.asyncDispose]();
        }, 'codebuddy-mcp.preset-lease');
        if (settings.systemPrompt) scoped.systemPrompt.section({ name: 'codebuddy:session-instructions', order: 100, text: settings.systemPrompt, interpolate: false });
        for (const tool of settings.tools ?? []) scoped.tools.register({
          name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => Array.isArray(value.content) ? value.content : [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args, exec) {
            const issues = validateJsonSchemaValue(tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} }, args);
            if (issues.length) throw new TypeError(`Invalid tool arguments: ${issues.join('; ')}`);
            const active = directCalls.get(exec.callId) ?? runFor(exec.agent);
            await active?.events;
            const value = await tool.execute(args, { sessionId: exec.agent.id, signal: exec.signal, callId: exec.callId });
            return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value ?? null };
          },
        });
        if (settings.toolFilter) restrictSessionTools(scoped, settings.toolFilter, shared?.key);
        for (const { role, selection: childSelection } of roleModels) {
          const roleTool = scoped.plugin(subagentToolPlugin, {
            provider: 'spawn', toolName: `subagent_${role}`, agentOptions: childSelection,
            persona: `You are CodeBuddy's ${role} subagent. Complete the delegated task within its scope and report actual results and unresolved verification.`,
          });
          await roleTool;
          if (roleTool.state !== 2) throw new Error(`Subagent role did not activate: ${role}`);
        }
        const compactFiber = scoped.plugin(compactionPlugin, {
          thresholdRatio: settings.autoCompactThreshold ?? 0.8,
          headroomTokens: 1024, maxTokens: 1024, retainRatio: Math.min(0.16, (settings.autoCompactThreshold ?? 0.8) / 2),
          auto: settings.autoCompact !== false,
        });
        await compactFiber;
        if (compactFiber.state !== 2) throw new Error('Harness compaction did not activate');
        const statuses = await Promise.all(mcpServers.filter(server => server.transport !== 'streamable-http').map(async server => {
          const started = performance.now();
          const connection = scoped.plugin(mcpPlugin, { ...server, failOnStartupError: true });
          try {
            await connection;
            if (connection.state !== 2) throw new Error('Connection did not activate');
            return { serverName: server.serverName, status: 'ready' };
          } catch {
            await connection.dispose();
            return { serverName: server.serverName, status: 'error', error: 'MCP connection or tool discovery failed. Reconfigure or retry this extension.' };
          } finally {
            console.info('[Harness MCP preparation]', JSON.stringify({
              sessionId, serverName: server.serverName,
              elapsedMs: Math.round(performance.now() - started),
            }));
          }
        }));
        connections.push(...statuses);
      },
    });
    try { await fiber; if (fiber.state !== 2) throw new Error('Session capability configuration failed'); }
    catch (error) { await fiber.dispose(); throw error; }
    sessionScopes.set(sessionId, fiber);
    sessionSettings.set(sessionId, settings);
    const orderedConnections = mcpServers.map(server => connections.find(connection => connection.serverName === server.serverName));
    extensionStates.set(sessionId, orderedConnections);
    return { configured: true, extensions: orderedConnections };
  }
  async function readMcpResourceTool(sessionId, name, args, { onPermission, signal = new AbortController().signal } = {}) {
    signal.throwIfAborted();
    const agent = await resolveAgent(sessionId), callId = randomUUID();
    // UI reads use their own exact approval callback and cancellation signal.
    // They neither enter the model inbox nor acquire its maintenance slot.
    directCalls.set(callId, { onPermission, events: Promise.resolve(), sessionId });
    try {
      const result = await ctx.tools.execute({ agent, callId, name, arguments: args, signal });
      signal.throwIfAborted();
      if (result.isError) throw new Error(result.error?.message ?? result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? 'MCP resource request failed');
      return result.value;
    } finally { directCalls.delete(callId); }
  }
  const driver = {
    version: HARNESS_VERSION,
    referenceSourceCommit: HARNESS_REFERENCE_COMMIT,
    dataDir: root,
    async createSession({ sessionId = randomUUID(), cwd: workingDirectory = cwd, provider, model, options }) {
      const work = creation.then(async () => {
        selection = await configureProvider(provider, model);
        const created = await ctx.sessionController.create({ sessionId, cwd: resolve(workingDirectory) });
        await ctx.sessionController.selectModel({ sessionId: created.sessionId, ...selection });
        if (options || !sessionScopes.has(created.sessionId)) await configureSession(created.sessionId, options);
        return { ...created, cwd: resolve(workingDirectory), provider: provider.id, model };
      });
      creation = work.catch(() => {});
      return work;
    },
    async prompt(sessionId, content, { onEvent, onPermission, signal, requestId = randomUUID(), resumeGoal } = {}) {
      if (runs.has(sessionId)) throw new Error(`Session ${sessionId} already has an active prompt`);
      if (!sessionScopes.has(sessionId)) throw new Error('Configure the session before prompting');
      signal?.throwIfAborted();
      const completion = Promise.withResolvers();
      // Attach rejection observation before admission can synchronously fail.
      completion.promise.catch(() => {});
      const run = { ...completion, onEvent, onPermission, events: Promise.resolve(), steps: 0, sessionId };
      runs.set(sessionId, run);
      const cancel = () => { try { driver.cancel(sessionId); } catch { /* Admission may not have opened a turn yet. */ } };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        await ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content: parts, clientTimeZone: 'Asia/Shanghai' }, signal ?? new AbortController().signal);
        if (resumeGoal) await driver.controlGoal(sessionId, { action: 'resume', ...resumeGoal });
        if (signal?.aborted) cancel();
        const result = await completion.promise;
        const agent = await resolveAgent(sessionId);
        await agent.whenIdle();
        // Official subagent runtime owns child completion and reply delivery.
        // Recheck the root after children settle because their replies may wake it.
        while (await ctx.subagents.waitForChildren(agent)) await agent.whenIdle();
        const jobs = run.jobSettlement ? await run.jobSettlement : [];
        await run.events;
        if (run.error) throw run.error;
        const goal = ctx.goals.get(agent);
        if (signal?.aborted || run.cancelRequested || run.lastResult?.stopReason === 'cancelled') return { stopReason: 'cancelled', reason: run.lastResult?.reason, jobs, ...(goal ? { goal } : {}) };
        return { ...(run.lastResult ?? result), ...(jobs.length ? { jobs } : {}), ...(goal ? { goal } : {}) };
      } catch (error) {
        driver.cancel(sessionId);
        const agent = ctx.agents.get(sessionId);
        if (agent) {
          await agent.whenIdle();
          while (await ctx.subagents.waitForChildren(agent)) await agent.whenIdle();
        }
        await run.jobSettlement;
        await run.events.catch(() => {});
        throw error;
      } finally {
        runs.delete(sessionId);
        signal?.removeEventListener('abort', cancel);
      }
    },
    configureSession,
    extensionStatus(sessionId) { return structuredClone(extensionStates.get(sessionId) ?? []); },
    async steer(sessionId, content, { signal = new AbortController().signal, requestId = randomUUID() } = {}) {
      if (!runs.has(sessionId)) throw new Error('Steering requires an active prompt; use prompt for an idle session');
      return ctx.sessionController.prompt({ sessionId, requestId, mode: 'steer', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, clientTimeZone: 'Asia/Shanghai' }, signal);
    },
    async listTools(sessionId) {
      const agent = sessionId ? await resolveAgent(sessionId) : undefined;
      return ctx.tools.schemas(agent).map(tool => {
        const metadata = mcpPlugin.getMcpToolMetadata(ctx, agent, tool.name);
        return metadata ? { ...tool, ...(metadata._meta ? { _meta: metadata._meta } : {}), ...(metadata.outputSchema ? { outputSchema: metadata.outputSchema } : {}), ...(metadata.mcpApp ? { mcpApp: metadata.mcpApp } : {}) } : tool;
      });
    },
    async callTool(sessionId, name, args, { onPermission, onEvent, signal = new AbortController().signal } = {}) {
      const agent = await resolveAgent(sessionId);
      if (agent.status !== 'idle' || runs.has(sessionId)) throw new Error('Direct tool calls require an idle session');
      const callId = randomUUID();
      const completion = Promise.withResolvers();
      completion.promise.catch(() => {});
      const run = { ...completion, onPermission, onEvent, events: Promise.resolve(), sessionId };
      directCalls.set(callId, run);
      try {
        return await agent.runMaintenance(async maintenanceSignal => {
          const metadata = mcpPlugin.getMcpToolMetadata(ctx, agent, name);
          emit(run, { type: 'tool_call', id: callId, name, arguments: args, sessionId, ...(metadata?.mcpApp ? { mcpApp: metadata.mcpApp } : {}) });
          const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: AbortSignal.any([signal, maintenanceSignal]) });
          emit(run, { type: 'tool_result', id: callId, result: result.content, isError: result.isError, sessionId, name, arguments: args, structuredContent: result.value, error: result.error, ...run.receipt });
          await run.events;
          return { ...result, ...(run.receipt?.mcpResult ? { mcpResult: run.receipt.mcpResult } : {}) };
        });
      } finally { directCalls.delete(callId); }
    },
    async contextUsage(sessionId) { return contextUsage((await resolveAgent(sessionId)).session); },
    async compact(sessionId, { signal = new AbortController().signal, onEvent } = {}) {
      const agent = await resolveAgent(sessionId);
      const scope = sessionScopes.get(sessionId);
      if (!scope) throw new Error('Configure the session before compaction');
      if (runs.has(sessionId) || maintenanceRuns.has(sessionId)) throw new Error('Compaction requires an idle session');
      const run = { onEvent, events: Promise.resolve(), reject() {} };
      maintenanceRuns.set(sessionId, run);
      try {
        const result = await scope.ctx.get('compaction').compactNow(agent, signal);
        await run.events;
        return result;
      } finally {
        await run.events.finally(() => maintenanceRuns.delete(sessionId));
      }
    },
    async listSkills(sessionId) {
      const agent = await resolveAgent(sessionId);
      return ctx.skills.list({ cwd: ctx.workingDirectory.get(agent.session), scope: agent });
    },
    readResource(sessionId, server, uri, options) { return readMcpResourceTool(sessionId, 'read_mcp_resource', { server, uri }, options); },
    listResources(sessionId, server, cursor, options) { return readMcpResourceTool(sessionId, 'list_mcp_resources', { server, ...(cursor === undefined ? {} : { cursor }) }, options); },
    refreshSkills() {
      const work = skillRefresh.then(async () => {
        const entry = [...ctx.loader.entries()].find(item => item.options.id === 'skill-filesystem');
        await entry.fiber.restart();
        return { refreshed: true };
      });
      skillRefresh = work.catch(() => {});
      return work;
    },
    async testExtension(server) {
      const key = {};
      const scope = createScope(ctx, key);
      try {
        const fiber = scope.ctx.plugin(mcpPlugin, { ...server, failOnStartupError: true, reconnect: { enabled: false } });
        await fiber;
        if (fiber.state !== 2) throw new Error(`MCP connection did not activate: ${server.serverName}`);
        return ctx.tools.schemas(key).filter(tool => tool.name.startsWith(`mcp__${server.serverName}__`));
      } finally { await scope.dispose(); }
    },
    memory: {
      get(scope, key) { return structuredClone(memoryRecords.get(memoryKey(scope, key))?.value); },
      list(scope) { if (!scope) throw new TypeError('Memory scope is required'); return [...memoryRecords.entries()].filter(([, row]) => row.scope === scope).map(([, row]) => ({ key: row.key, value: structuredClone(row.value) })); },
      async set(scope, key, value) { const id = memoryKey(scope, key); const parsed = z.json().parse(value); await memoryRecords.put(id, { scope, key, value: structuredClone(parsed) }); return structuredClone(parsed); },
      async delete(scope, key) { return memoryRecords.delete(memoryKey(scope, key)); },
    },
    cancel(sessionId) {
      const run = runs.get(sessionId);
      if (run) run.cancelRequested = true;
      const agent = ctx.agents.get(sessionId);
      if (agent) ctx.goals.disarm(agent);
      const result = ctx.sessionController.cancel({ sessionId });
      cancelChildren(sessionId);
      settleRun(agent);
      return result;
    },
    async getGoal(sessionId) { return ctx.goals.get(await resolveAgent(sessionId)); },
    async controlGoal(sessionId, { action, goalId, revision }) {
      if (!['pause', 'resume'].includes(action)) throw new TypeError('Goal control action must be pause or resume');
      if (action === 'resume' && !runs.has(sessionId)) throw new Error('Resume a goal through prompt with resumeGoal so its stream and permissions remain attached');
      const agent = await resolveAgent(sessionId);
      // The UI supplies structured human intent and the official CAS identity.
      // Resume arms the official round driver; this adapter never queues work.
      const goal = ctx.goals[action](agent, { id: goalId, revision });
      await ctx.sessions.flush(agent.session);
      return goal;
    },
    async listSessions() { return (await ctx.sessionController.list({}, new AbortController().signal)).items; },
    async history(sessionId) { return ctx.sessionController.inspect(sessionId); },
    listSubagentChildren(parentSessionId, signal) { return ctx.subagents.listChildren(parentSessionId, signal); },
    async forkWorkingDirectory(sessionId, workingDir, { signal } = {}) {
      const agent = await resolveAgent(sessionId);
      return forkWorkingDirectory(ctx, agent, workingDir, { signal, selection,
        isBusy: () => runs.has(sessionId) || [...directCalls.values()].some(call => call.sessionId === sessionId) || ctx.jobs.list(sessionId).some(job => ['running', 'stopping'].includes(job.status)) });
    },
    async releaseNativeSessionCapabilities(sessionId) {
      const agent = ctx.agents.get(sessionId);
      if (runs.has(sessionId) || (agent && agent.status !== 'idle') || [...directCalls.values()].some(call => call.sessionId === sessionId) || ctx.jobs.list(sessionId).some(job => ['running', 'stopping'].includes(job.status))) throw new Error('Wait for active session operations and background jobs before releasing capabilities');
      await sessionScopes.get(sessionId)?.dispose();
      sessionScopes.delete(sessionId); sessionSettings.delete(sessionId); extensionStates.delete(sessionId);
    },
    async rename(sessionId, title) { return ctx.sessionController.rename({ sessionId, title }); },
    async fork(sessionId, { atSeq, beforeRequestId } = {}) {
      const agent = ctx.agents.get(sessionId);
      if (runs.has(sessionId) || (agent && agent.status !== 'idle') || [...directCalls.values()].some(call => call.sessionId === sessionId) || ctx.jobs.list(sessionId).some(job => ['running', 'stopping'].includes(job.status))) throw new Error('Forking requires an idle session without active operations or background jobs');
      if (atSeq !== undefined && beforeRequestId !== undefined) throw new TypeError('Choose either atSeq or beforeRequestId');
      if (beforeRequestId !== undefined) {
        if (typeof beforeRequestId !== 'string' || !beforeRequestId) throw new TypeError('beforeRequestId must be text');
        const history = await ctx.sessionController.inspect(sessionId);
        // Admission precedes the visible user/message. Cutting at user/message
        // would retain its queued input and could replay the text being edited.
        const admission = history.events.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(item => item.source?.kind === 'user' && item.source.rpcId === beforeRequestId));
        if (!admission || admission.seq < 1) throw new Error('No exact prompt admission boundary exists for this message');
        atSeq = admission.seq - 1;
      }
      const result = await ctx.sessionController.fork({ sessionId, ...(atSeq !== undefined ? { atSeq } : {}) });
      // The public pointer may be committed immediately after this call. Make
      // its new native history durable before a product state can reference it.
      await ctx.sessions.flush((await resolveAgent(result.sessionId)).session);
      return result;
    },
    follow(sessionId, signal) { return ctx.sessionController.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, signal); },
    async upload(sessionId, { data, name }, signal = new AbortController().signal) {
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) throw resolved.error;
      return ctx.fileUploads.upload(resolved.agent, { data, name }, signal);
    },
    async fetch(request) {
      const route = routes.get(new URL(request.url).pathname);
      if (!route || !route.methods.includes(request.method)) return new Response('Not found', { status: 404 });
      return route.fetch(request);
    },
    async close() { for (const sessionId of runs.keys()) driver.cancel(sessionId); await ctx.fiber.dispose(); },
  };
  return driver;
}
