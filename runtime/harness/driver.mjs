import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { boot } from '@deepseek-ai/dsh-app-boot';
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm';
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import compactionPlugin, { installCompactionRequestCompatibility } from './compaction.mjs';
import * as mcpPlugin from './mcp-bridge.mjs';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createScope, bindScopeParent, scopeChainOf } from '@deepseek-ai/dsh-scope';
import { symbols } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { profileEntries } from './profile.mjs';
import { DEFAULT_CONTEXT_WINDOW } from '../model-defaults.mjs';
import { toolSessionApprovalScope, sameToolSessionScope } from '../tool-session-approval.mjs';
import { MCP_RESOURCE_TOOL_NAMES } from '../mcp-settings.mjs';
import { forkWorkingDirectory } from './working-directory.mjs';
import { observeModelTransport } from './transport-observation.mjs';
import { installModelResponseValidation } from './model-response-validation.mjs';
import { createMcpPresets, restrictSessionTools } from './mcp-presets.mjs';
import { installToolDiscovery } from './tool-discovery.mjs';
import { installSubagentTemplates } from './subagent-templates.mjs';
import { installSubagentNoticeAdmission } from './subagent-notice-admission.mjs';
import { validateSubagentLimits } from '../subagent-limits.mjs';
import { createToolInputPreview } from './tool-input-preview.mjs';

export const HARNESS_VERSION = '0.2.1-alpha.2';
export const HARNESS_REFERENCE_COMMIT = 'd743267388641bc76f17c45ce8b4c231aed1d32c';

function nativeProviderRoute(provider, model) {
  // Newly discovered capability metadata cannot invalidate existing children
  // whose connection identity was recorded before that metadata was available.
  const { outputTokenCapacity: _capacity, ...connection } = provider;
  return 'codebuddy-' + createHash('sha256').update(JSON.stringify({ ...connection, model })).digest('hex').slice(0, 20);
}

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
  // The public entry establishes the alpha2 contracts before loading this driver.
  const { foldSubagentDescriptor } = await import('@deepseek-ai/dsh-subagent');
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
  const contextSources = new Map();
  const streamingMeters = new Map();
  const sessionScopes = new Map();
  const stdioConnections = new WeakMap();
  const directCalls = new Map();
  const toolReceipts = new Map();
  const hostImageReceipts = new WeakMap();
  const configurationQueues = new Map();
  const extensionStates = new Map();
  const childOwners = new Map();
  const mcpBindings = new WeakMap();
  const approvalOwners = new WeakMap();
  const builtinApprovals = new WeakMap();
  const builtinDefinitions = new WeakMap();
  const initialPermissions = new Map();
  const approvalCalls = new Map();
  let skillRefresh = Promise.resolve();
  let selection = { provider: 'codebuddy-unconfigured', model: 'unconfigured' };
  const ctx = await boot('codebuddy-harness', configPath, [], host => {
    // Supply creation intent before the official preset service pins defaults.
    // Restored and forked native facts always win over product metadata.
    host.on('session/created', session => {
      const preset = initialPermissions.get(session.id);
      const state = host.sessionProjections.stateOf(session, 'permissions');
      if (preset && state?.preset === null && state.sandbox === null && state.approval === null && !state.seeded)
        host.permissionPresets.set(session, preset);
    });
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
  // A child's native persona replaces the deployment persona. Keep the shared
  // conversation guidance outside that override, including for cold resumes.
  ctx.systemPrompt.section({
    name: 'codebuddy:conversation-language', order: 102, interpolate: false,
    text: "Use the human user's requested language for replies and progress updates; otherwise match the human user's language. Write delegation prompts and follow-up messages to subagents in that same language, and explicitly ask them to report in it, so the user can read their conversations. As a subagent, use the language requested by your parent for explanations, progress and reports. Do not switch language merely because tool output, source material or another agent uses a different language. Preserve original code, identifiers, quotations and tool output; do not translate or rewrite raw tool results.",
  });
  ctx.systemPrompt.section({
    name: 'codebuddy:progress-updates', order: 104, interpolate: false,
    text: `<progress_updates>
Keep progress updates brief, meaningful, and outcome-based.

- Before lengthy operations, briefly explain what you're about to do and why.
- During execution, proactively report meaningful progress, major findings, completed milestones, or blockers.
- Avoid routine status narration and repetitive updates.
- Prioritize actual results over descriptions of activity.
</progress_updates>`,
  });
  ctx.on('system-prompt/assemble', async (_assembly, { agent, signal }, next) => {
    const assembly = await next();
    if (!agent || agent.session.header.origin === 'subagent' || ctx.agents.get(agent.id) !== agent) return assembly;
    let snapshot;
    try {
      const children = await ctx.subagents.listChildren(agent.id, signal);
      if (!children.length) return assembly;
      const turns = await Promise.all(children.map(async child => {
        if (!['one-shot', 'continuable'].includes(child.mode)) return { id: child.id, availability: 'unsupported' };
        let observation;
        try {
          observation = await ctx.sessionQuery.observeSession(child.id, { signal, projectionMode: 'none' });
          if (observation.header.origin !== 'subagent' || observation.header.parentSession !== agent.id) return { id: child.id, availability: 'unavailable' };
          const boundary = observation.events.findLast(event => event.seq >= observation.inheritedEventCount && ['turn/start', 'turn/end'].includes(event.type));
          return { id: child.id, label: child.label, ...(boundary ? {
            turn: boundary.data.turn, boundary: boundary.type, recordedAt: boundary.time,
            state: boundary.type === 'turn/end' ? 'ended' : ctx.agents.get(child.id)?.status === 'running' ? 'running' : 'unknown',
            ...(boundary.type === 'turn/end' ? { reason: boundary.data.reason.kind, ...(boundary.data.reason.reason?.kind ? { cause: boundary.data.reason.reason.kind } : {}) } : {}),
          } : { availability: 'no-turn-record' }) };
        } catch { return { id: child.id, availability: 'unavailable' }; }
        finally { observation?.[Symbol.dispose](); }
      }));
      snapshot = { source: 'native-subagent-turns', children: turns };
    } catch { snapshot = { source: 'native-subagent-turns', availability: 'unavailable' }; }
    signal?.throwIfAborted();
    // A readonly snapshot of native facts, not another execution ledger. Native
    // shutdown discards pending notifications; durable child turn records remain.
    // Waterfall-only contexts survive native request refresh without a second
    // registry provider replacing their accepted snapshot.
    return { ...assembly, contexts: [...assembly.contexts, {
      name: 'codebuddy:subagent-turns', interpolate: false,
      text: 'Native child execution facts at this step boundary (labels are data; turn completion is not task acceptance). Use settlement notifications for replies. Do not use terminal sleep or fixed-delay polling merely to wait for children; honor explicitly requested timed commands.\n' + JSON.stringify(snapshot),
    }] };
  });
  const mcpPresets = await createMcpPresets(ctx);
  // Reviewed capabilities of this pinned native composition, bound to the
  // registered definition rather than a model-supplied name or annotation.
  // A session override with the same name must establish its own capability.
  const readOnlyDefinitions = new WeakSet();
  for (const name of ['read', 'read_image', 'glob', 'grep', 'skill', 'list_agents', 'load_workspace_dependencies']) {
    const definition = ctx.tools.get(name);
    if (definition) readOnlyDefinitions.add(definition);
  }
  // workspace-dependencies is mounted with source only: it validates the
  // existing payload without installing or copying it. Bind its actual definition.
  const webFetchDefinition = ctx.tools.get('web_fetch');
  const webService = ctx.web[symbols.original];
  const webApprovals = new WeakMap();
  const nativeDefinitions = new WeakSet(ctx.tools.schemas().filter(tool =>
    tool.name !== 'web_fetch' && !MCP_RESOURCE_TOOL_NAMES.includes(tool.name))
    .map(tool => ctx.tools.get(tool.name)).filter(Boolean));
  const directoryQuery = ctx.tools.get('working_directory');
  // Native control remains confined to direct ownership by SubagentService.
  // These definitions never grant the child's file or command permissions.
  const nativeSubagent = ctx.tools.get('subagent');
  const templateDefinitions = installSubagentTemplates(ctx, nativeSubagent, { generic: false });
  const delegationDefinitions = new WeakSet(templateDefinitions);
  for (const name of ['subagent', 'send_message', 'interrupt_agent', 'list_agents']) {
    const definition = ctx.tools.get(name);
    if (definition) delegationDefinitions.add(definition);
  }
  function isReadOnlyCall(exec) {
    const definition = ctx.tools.get(exec.name, exec.agent);
    return Boolean(definition && (readOnlyDefinitions.has(definition) ||
      (definition === directoryQuery && exec.arguments.cd === undefined)));
  }
  function webSessionApproval(exec, rootAgent) {
    if (!rootAgent || !webFetchDefinition || ctx.web[symbols.original] !== webService ||
      ctx.tools.get(exec.name, exec.agent) !== webFetchDefinition) return undefined;
    let url;
    try { url = new URL(exec.arguments.url); } catch { return undefined; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    let origins = webApprovals.get(rootAgent);
    if (!origins) { origins = new Map(); webApprovals.set(rootAgent, origins); }
    let binding = origins.get(url.origin);
    if (!binding) {
      binding = { identity: Object.freeze({}), extensionSource: 'builtin', targetOrigin: url.origin };
      origins.set(url.origin, binding);
    }
    return {
      ...binding,
      isCurrent: () => ctx.web[symbols.original] === webService &&
        ctx.tools.get(exec.name, exec.agent) === webFetchDefinition &&
        webApprovals.get(rootAgent)?.get(url.origin) === binding,
    };
  }

  async function builtinSessionApproval(exec, rootAgent) {
    const definition = ctx.tools.get(exec.name, exec.agent);
    const registration = definition && builtinDefinitions.get(definition);
    const binding = rootAgent && builtinApprovals.get(rootAgent)?.get(exec.name);
    if (!registration || !binding || !sameToolSessionScope(registration.scope, binding.scope) ||
      toolSessionApprovalScope(registration.tool) !== registration.scope || !(await registration.scope.accepts(exec.arguments))) return undefined;
    exec.signal.throwIfAborted();
    return {
      identity: binding.identity, extensionSource: 'builtin',
      ...(registration.scope.business ? { business: {
        identity: binding.identity, presentation: registration.scope.business,
        isCurrent: () => builtinApprovals.get(rootAgent)?.get(exec.name) === binding &&
          ctx.tools.get(exec.name, exec.agent) === definition && toolSessionApprovalScope(registration.tool) === registration.scope,
      } } : {}),
      isCurrent: () => builtinApprovals.get(rootAgent)?.get(exec.name) === binding &&
        ctx.tools.get(exec.name, exec.agent) === definition && toolSessionApprovalScope(registration.tool) === registration.scope,
    };
  }

  function isInternalControl(agent, name) {
    const definition = ctx.tools.get(name, agent);
    return Boolean(definition && delegationDefinitions.has(definition));
  }

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
    unavailable(exec, source) {
      // A desktop action receipt remains true even if its image cannot be read.
      // Stop the native loop before another model step (or queued tool) can
      // act blindly. Other MCPs may return optional illustrations.
      if (source.extensionName !== 'qwen_computer') return;
      const run = runFor(exec.agent);
      if (run) run.observationFailure = Object.assign(new Error(
        '电脑控制已停止：工具已返回截图，但当前模型没有可用的视觉结果。请在“模型与运行”中选择支持图片的模型，或配置辅助视觉，再重新观察窗口。已执行的操作不会重放，发送状态尚未核实。',
      ), { code: 'desktop/vision-unavailable' });
    },
    async project(content, exec) {
      const routed = exec.agent?.session.requestHeader()?.config;
      const provider = routed?.provider ?? exec.agent?.options.provider;
      const model = routed?.model ?? exec.agent?.options.model;
      const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal);
      if (info.inputModalities?.includes('image')) return content;
      const fallback = settingsFor(exec.agent)?.mcpImageFallback;
      if (!fallback) throw new Error('No image-capable model or auxiliary observer is configured');
      return fallback(content, { sessionId: exec.agent.id, toolName: exec.name, signal: exec.signal });
    },
  });
  function emit(run, event) {
    if (!run) return;
    run.events = run.events.then(() => run.onEvent?.(event));
    run.events.catch(error => { run.error = error; run.reject(error); });
  }
  ctx.on('user-questions/request', async (request, next) => {
    const active = runFor(request.agent);
    if (!active?.onUserQuestions) return next();
    let remainingMs;
    if (request.wait?.timed) {
      const wait = ctx.userQuestions.attachWait(request.agent, request.wait.callId, request.signal);
      try { remainingMs = (await wait.next()).value?.remainingMs; }
      finally { await wait.return(); }
    }
    // Read and release the native wait: Host keeps the timer; the desktop only
    // displays its remaining duration and never settles a second deadline.
    return active.onUserQuestions({ ...request, ...(request.wait ? { wait: { ...request.wait, remainingMs } } : {}) });
  });
  function userQuestions(session) {
    const snapshot = ctx.sessionProjections.stateOf(session, 'userQuestions')?.questions ?? { active: [], settled: [] };
    const run = runs.get(session.id);
    const boundary = session.log.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    // Product reply window: only questions of the still-running native turn.
    // Native history is retained; finishing/stopping never manufactures answers.
    const calls = run && !run.cancelRequested && boundary?.type === 'turn/start'
      ? new Set(session.log.slice(boundary.seq + 1).flatMap(event => event.type === 'tool/call' ? [event.data.callId]
        : event.type === 'tool/ptc-dispatch' ? [event.data.subCallId] : [])) : new Set();
    return { nativeSessionId: session.id, ...structuredClone({
      active: snapshot.active.filter(q => calls.has(q.callId)),
      settled: snapshot.settled.filter(q => calls.has(q.callId)),
    }) };
  }
  function contextUsage(session) {
    const snapshot = ctx.sessionProjections.snapshot(session, ['tokenUsage', 'contextPressure']);
    const meter = ctx.tokenMeter.measure(session);
    const usage = snapshot.values.tokenUsage;
    const pressure = snapshot.values.contextPressure;
    return {
      type: 'context_usage', sessionId: session.id, revision: meter.logRevision,
      used: meter.totalTokens, contextLimit: pressure?.contextWindow,
      contextSource: contextSources.get(session.id) ?? 'fallback',
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
  ctx.effect(() => installCompactionRequestCompatibility(ctx,
    agent => settingsFor(agent)?.thinkingEffort), 'CodeBuddy compaction request compatibility');
  ctx.effect(() => observeModelTransport(ctx, event => {
    const run = runFor(ctx.agents.get(event.sessionId));
    emit(run, event);
    console.warn('[Harness model transport]', JSON.stringify(event));
  }), 'CodeBuddy model transport observation');
  ctx.effect(() => installModelResponseValidation(ctx), 'CodeBuddy model response validation');
  const noticeAdmission = installSubagentNoticeAdmission(ctx, agent => runs.get(agent.id));
  ctx.effect(() => () => noticeAdmission.dispose(), 'CodeBuddy native subagent notice admission');
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return;
    const parent = ctx.agents.get(agent.session.header.parentSession);
    if (!parent || !ctx.agents.isOwnedBy(agent.id, parent)) return;
    const inherited = settingsFor(parent);
    if (!inherited) return;
    // Spawn intentionally creates a flat upstream scope. Install this host's
    // selected capabilities before its loop starts. Native delegation inherits
    // the parent's actual request model and effort without a host override.
    // Cold continuation carries its exact native route, even after a template
    // selects another model. Rehydrate only a matching current connection;
    // never substitute the template's new model into that descriptor.
    if (!providers.has(agent.options.provider) && inherited.restoreSubagentProvider) {
      const context = agent.session.requestContext();
      const recorded = context?.provider === agent.options.provider && context.model === agent.options.model
        ? { contextWindow: context.contextWindow, reasoningEffort: agent.options.reasoningEffort } : undefined;
      const provider = await inherited.restoreSubagentProvider(agent.options.model,
        candidate => nativeProviderRoute(candidate, agent.options.model) === agent.options.provider, recorded);
      if (!provider || nativeProviderRoute(provider, agent.options.model) !== agent.options.provider)
        throw new Error('The original subagent model connection is unavailable; its model was not changed.');
      await configureProvider(provider, agent.options.model);
    }
    const { thinkingEffort: _parentEffort, ...capabilities } = inherited;
    await applySessionOptions(agent.id, capabilities, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return;
    sessionSettings.delete(agent.id);
    sessionScopes.delete(agent.id);
    extensionStates.delete(agent.id);
  });
  async function permissionCall(exec, active) {
    const definition = ctx.tools.get(exec.name, exec.agent);
    const rootAgent = ctx.agents.get(active.sessionId);
    const currentMcpBinding = () => mcpPlugin.getMcpSessionApproval(ctx, exec.agent, exec.name) ??
      mcpPlugin.getMcpResourceSessionApproval(ctx, exec.agent, exec.name, exec.arguments.server);
    const mcpBinding = currentMcpBinding();
    const binding = mcpBinding ?? webSessionApproval(exec, rootAgent) ?? await builtinSessionApproval(exec, rootAgent);
    const business = mcpBinding
      ? (settingsFor(exec.agent)?.mcpApprovalScopes ?? []).map(scope =>
        mcpPlugin.getMcpBusinessSessionApproval(ctx, exec.agent, exec.name, scope)).find(Boolean)
      : binding?.business;
    let sessionApproval;
    if (binding && rootAgent) {
      let owner = approvalOwners.get(rootAgent);
      if (!owner) { owner = Object.freeze({}); approvalOwners.set(rootAgent, owner); }
      sessionApproval = {
        owner, tool: binding.identity, extensionSource: binding.extensionSource,
        ...(business ? { business } : {}),
        ...(binding.targetOrigin ? { targetOrigin: binding.targetOrigin } : {}),
        isCurrent: () => ctx.agents.get(active.sessionId) === rootAgent && approvalOwners.get(rootAgent) === owner &&
          (mcpBinding ? currentMcpBinding() === binding : binding.isCurrent()),
      };
    }
    return {
      ...(sessionApproval ? { sessionApproval } : {}),
      delegated: exec.agent.id !== active.sessionId,
      id: exec.callId, name: exec.name, arguments: exec.arguments, readOnly: isReadOnlyCall(exec),
      nativeCapability: Boolean(definition && nativeDefinitions.has(definition)),
      delegationControl: Boolean(definition && delegationDefinitions.has(definition)),
      sandboxMode: ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode,
      sessionId: exec.agent.id, signal: exec.signal,
    };
  }
  ctx.on('approval/request', async (request, next) => {
    const active = directCalls.get(request.callId) ?? runFor(request.agent);
    if (!active?.onPermission) return next();
    const call = approvalCalls.get(`${request.agent.id}\0${request.callId}`) ?? {
      id: request.callId, name: request.toolName, arguments: {}, sessionId: request.agent.id,
    };
    if (request.signal) await abortable(active.events, request.signal);
    else await active.events;
    const accepted = await active.onPermission({ ...call, reason: request.reason, signal: request.signal });
    return accepted === true ? 'allowed-once' : 'rejected';
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    const active = directCalls.get(exec.callId) ?? runFor(exec.agent);
    if (active?.cancelRequested || exec.signal.aborted) return { kind: 'cancel' };
    if (!active) return { kind: 'deny', reason: 'No active tool invocation context.' };
    if (active.observationFailure) return { kind: 'deny', reason: active.observationFailure.message };
    try {
      await abortable(active.events, exec.signal);
      const call = await permissionCall(exec, active);
      approvalCalls.set(`${exec.agent.id}\0${exec.callId}`, call);
      let gate = active.onToolPolicy
        ? await abortable(active.onToolPolicy(call), exec.signal)
        : { kind: call.nativeCapability || call.readOnly || call.delegationControl || call.sandboxMode === 'danger-full-access' ? 'allow' : 'ask' };
      if (!['allow', 'ask', 'deny', 'cancel'].includes(gate?.kind) ||
        (gate.kind === 'deny' && (typeof gate.reason !== 'string' || !gate.reason)))
        return { kind: 'deny', reason: 'The tool policy returned an invalid decision.' };
      if (exec.signal.aborted || active.cancelRequested) return { kind: 'cancel' };
      // Direct UI requests have no model turn. Their existing explicit user
      // confirmation is separate from Agent approval, whose audit requires a turn.
      if (directCalls.has(exec.callId) && gate.kind === 'ask') {
        const accepted = await active.onPermission?.(call);
        gate = { kind: accepted === true ? 'allow' : 'deny', reason: 'Direct tool approval was declined.' };
      }
      return gate.kind === 'allow' ? next() : gate;
    } catch (error) {
      if (exec.signal.aborted || active.cancelRequested) return { kind: 'cancel' };
      return { kind: 'deny', reason: 'Tool approval did not complete.' };
    }
  });
  ctx.on('tools/execute', async (exec, next) => {
    const active = directCalls.get(exec.callId) ?? runFor(exec.agent);
    await active?.onToolStart?.(approvalCalls.get(`${exec.agent.id}\0${exec.callId}`) ?? await permissionCall(exec, active));
    return next();
  });
  ctx.on('tools/result', (exec, result) => {
    approvalCalls.delete(`${exec.agent.id}\0${exec.callId}`);
    const metadata = mcpPlugin.takeMcpResultMetadata(exec, result);
    const presentationContent = !result.isError ? hostImageReceipts.get(exec) : undefined;
    hostImageReceipts.delete(exec);
    const receipt = { name: exec.name, arguments: exec.arguments, internalControl: isInternalControl(exec.agent, exec.name), structuredContent: result.value, error: result.error, ...metadata,
      ...(presentationContent ? { presentationContent } : {}),
    };
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
      streamingMeters.set(agent.id, { attemptId: frame.attemptId, assembler: new BlockAssembler(), preview: createToolInputPreview(), publishedPreviews: new Map(), previewSentAt: 0, baseline: contextUsage(agent.session), lastSent: 0 });
      emit(run, { type: 'assistant_start', attemptId: frame.attemptId, turn: frame.turn, step: frame.step, sessionId: agent.id });
      return;
    }
    if (frame.type !== 'chunk') {
      streamingMeters.delete(agent.id);
      emit(run, { type: 'assistant_end', attemptId: frame.attemptId, sessionId: agent.id });
      return;
    }
    const chunk = frame.chunk;
    const live = streamingMeters.get(agent.id);
    if (live?.attemptId === frame.attemptId) {
      live.assembler.push(chunk);
      live.preview.push(chunk);
      if (chunk.type === 'tool-call-delta') {
        const preview = live.preview.read(chunk.index);
        if (preview && !isInternalControl(agent, preview.name)) {
          const previous = live.publishedPreviews.get(chunk.index);
          const metadataChanged = !previous || previous.id !== preview.id || previous.name !== preview.name || previous.path !== preview.path;
          // A late complete path may be followed immediately by stream end.
          // Throttle size updates, never the first received identity or path.
          if (metadataChanged || Date.now() - live.previewSentAt >= 250) {
            live.previewSentAt = Date.now();
            live.publishedPreviews.set(chunk.index, preview);
            emit(run, { type: 'tool_input', preview, attemptId: frame.attemptId, sessionId: agent.id });
          }
        }
      }
      if (Date.now() - live.lastSent >= 250 && ['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(chunk.type)) {
        live.lastSent = Date.now();
        // Display only: use upstream block assembly and pricing. The durable
        // meter and native compaction still own all request/pressure decisions.
        emit(run, { ...live.baseline, used: live.baseline.used + estimateContent(live.assembler.blocks()) + 4, source: 'streaming_estimate' });
      }
    }
    if (chunk.type === 'text-delta') emit(run, { type: 'text_delta', text: chunk.text, attemptId: frame.attemptId, sessionId: agent.id });
    if (chunk.type === 'reasoning-delta') emit(run, { type: 'thinking_delta', text: chunk.text, attemptId: frame.attemptId, sessionId: agent.id });
    if (chunk.type === 'usage') emit(run, { type: 'usage', ...chunk.usage, sessionId: agent.id });
  });
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    const run = runFor(agent);
    if (!run) return;
    if (event.type === 'tool/call') {
      let args = event.data.arguments;
      try { args = JSON.parse(args); } catch { /* Preserve invalid native input for error display. */ }
      const metadata = mcpPlugin.getMcpToolMetadata(ctx, agent, event.data.name);
      emit(run, { type: 'tool_call', id: event.data.callId, name: event.data.name,
        internalControl: isInternalControl(agent, event.data.name), arguments: args, sessionId: session.id,
        ...(metadata?.mcpApp ? { mcpApp: metadata.mcpApp } : {}) });
    }
    // Native turn/start is synchronous and precedes inbox claim. Cancelling at
    // pre-step is too late: keepInbox cannot retain already claimed notices.
    // Keep turn/start/end so even an immediately cancelled run can settle.
    if (event.type === 'turn/start' && run.cancelRequested)
      agent.cancel({ kind: 'user' }, { keepInbox: true });
    if (session.id === run.sessionId && ['tool/result', 'tool/ptc-dispatch', 'user/message', 'turn/end'].includes(event.type))
      emit(run, { type: 'user_questions', sessionId: session.id, snapshot: userQuestions(session) });
    if (event.type === 'user/message' && event.data.source?.kind === 'skill-invocation') {
      emit(run, { type: 'skill_loaded', name: event.data.source.name, seq: event.seq, sessionId: session.id });
    }
    if (event.type === 'tool/result' && event.surfaceOp?.op !== 'replace') {
      const msg = event.data.message;
      const receiptKey = `${session.id}\0${msg.toolCallId}`;
      const receipt = toolReceipts.get(receiptKey);
      toolReceipts.delete(receiptKey);
      emit(run, { type: 'tool_result', id: msg.toolCallId, result: msg.content, isError: msg.isError, messageId: msg.id, sessionId: session.id, ...receipt });
    }
    if (event.type === 'assistant/message') emit(run, {
      type: 'assistant_committed', messageId: event.data.message.id, seq: event.seq, sessionId: session.id,
      hasText: event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0),
    });
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'todo/write' || event.type === 'goal/change' || ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type) || event.type.startsWith('llm/retry') || event.type.startsWith('compaction/') || event.type.startsWith('subagent/')) emit(run, { type: 'harness_event', event, sessionId: session.id });
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
    if (run?.observationFailure) throw run.observationFailure;
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
    if (sessionSettings.has(agent.id)) {
      // Main-chat selection replaces the old effort; native children retain
      // their own inherited request selection when no override is supplied.
      if (settings.thinkingEffort !== undefined) config.reasoningEffort = settings.thinkingEffort;
      else if (agent.session.header.origin !== 'subagent') delete config.reasoningEffort;
    }
    return config;
  });

  let creation = Promise.resolve();
  let providerConfiguration = Promise.resolve();
  let limitsConfiguration = Promise.resolve();
  function configureSubagentLimits(value) {
    const limits = validateSubagentLimits(value);
    const work = limitsConfiguration.then(async () => {
      if (ctx.subagents.config.maxDepth.get() === limits.maxDepth &&
          ctx.subagents.config.maxActiveSubagents.get() === limits.maxActiveSubagents) return;
      const entry = [...ctx.loader.entries()].find(item => item.options.id === 'subagents');
      // Both official fields are volatile: updating them does not replace the
      // manager or interrupt children. DSH remains the admission authority.
      await entry.update({ config: limits });
      await ctx.loader.await();
    });
    limitsConfiguration = work.catch(() => {});
    return work;
  }
  function configureProvider(provider, model) {
    const work = providerConfiguration.then(() => configureProviderNow(provider, model));
    providerConfiguration = work.catch(() => {});
    return work;
  }
  async function configureProviderNow(provider, model) {
    if (!provider || typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) throw new Error('Configure a model endpoint before starting a Harness session.');
    if (typeof model !== 'string' || !model.trim()) throw new Error('A model id is required.');
    const protocol = provider.protocol ?? 'openai-completions';
    const route = nativeProviderRoute(provider, model);
    const digest = route.slice('codebuddy-'.length);
    if (!providers.has(route) || providers.get(route).defaultMaxTokens !== provider.outputTokenCapacity) {
      const keyRef = `CODEBUDDY_MODEL_${digest}`;
      // Always explicit: never let pi-ai fall through to ambient API credentials.
      credentials.set(keyRef, provider.apiKey || 'codebuddy-no-key');
      const profile = {
        api: protocol,
        baseURL: provider.baseUrl,
        apiKeyEnv: keyRef,
        // Omission uses the official provider policy and the official retry plugin.
        ...(provider.retryPolicy ? { retryPolicy: provider.retryPolicy } : {}),
        // A discovered output capability is not a fixed request budget. Keep
        // native dynamic fitting; only an explicit budget becomes a call default.
        ...(provider.outputTokenCapacity === undefined ? {} : { defaultMaxTokens: provider.outputTokenCapacity }),
        models: [{ id: model, contextWindow: provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW, ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }), input: provider.inputModalities ?? ['text'], ...(provider.reasoningEfforts !== undefined ? { reasoningEfforts: provider.reasoningEfforts } : {}) }],
        // Choose the supported native wire format without changing the saved
        // route identity: old chat-local children must remain cold-resumable.
        ...(protocol === 'openai-completions' && new URL(provider.baseUrl).hostname === 'ollama.com'
          ? { compat: { ...provider.compat, maxTokensField: 'max_tokens' } }
          : provider.compat ? { compat: provider.compat } : {}),
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
  async function releaseStdioConnections(agent) {
    const connections = stdioConnections.get(agent);
    stdioConnections.delete(agent);
    if (connections) await Promise.all([...connections.values()].map(entry => entry.fiber.dispose()));
  }
  async function applySessionOptions(sessionId, options, createdAgent) {
    const agent = createdAgent ?? await resolveAgent(sessionId);
    if (agent.status !== 'idle' || runs.has(sessionId)) throw new Error('Session settings can only change while idle');
    const previous = sessionSettings.get(sessionId) ?? {};
    // Obsolete role routing and per-session limits cannot alter this Host's
    // generic native delegation policy, including when replayed from old data.
    const { roleModels: _roleModels, maxParallelSubagents: _parallel, maxParallelCoders: _coders, initialPermissionPreset: _initialPreset, ...settings } = { ...previous, ...options };
    let childFilter;
    if (agent.session.header.origin === 'subagent') {
      const observation = await ctx.sessionQuery.observeSession(agent.id, { projectionMode: 'none' });
      try { childFilter = foldSubagentDescriptor(observation.events.slice(observation.inheritedEventCount))?.toolFilter; }
      finally { observation[Symbol.dispose](); }
    }
    // Native restrictions mask inherited capabilities, while scope-local
    // registrations are intentionally exempt. Reinstalled host/stdio tools
    // must therefore consume the same recorded filter before registration.
    const filters = childFilter ? [settings.toolFilter, childFilter].filter(Boolean) : [];
    const allowLists = filters.flatMap(filter => filter.allow === undefined ? [] : [filter.allow]);
    const registrationFilter = filters.length ? {
      ...(allowLists.length ? { allow: allowLists.reduce((kept, list) => kept.filter(name => list.includes(name))) } : {}),
      deny: [...new Set(filters.flatMap(filter => filter.deny ?? []))],
    } : undefined;
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
    if (settings.projectToolContext !== undefined && typeof settings.projectToolContext !== 'function')
      throw new TypeError('Host tool context projection must be a function');
    const builtinBindings = new Map();
    for (const tool of settings.tools ?? []) {
      const scope = toolSessionApprovalScope(tool);
      if (!scope) continue;
      const previousBinding = builtinApprovals.get(agent)?.get(tool.name);
      builtinBindings.set(tool.name, sameToolSessionScope(scope, previousBinding?.scope)
        ? previousBinding : { scope, identity: Object.freeze({}) });
    }
    const subagentModels = {};
    for (const [role, configured] of Object.entries(settings.subagentModels ?? {})) {
      if (!['explorer', 'browser', 'generic'].includes(role)) throw new TypeError('Unknown subagent model role');
      subagentModels[role] = configured.error ? { error: configured.error } : await configureProvider(configured.provider, configured.model);
    }
    const subagentTemplates = await Promise.all((settings.subagentTemplates ?? []).map(async template => ({
      ...template,
      model: !template.model || template.model.error ? template.model : await configureProvider(template.model.provider, template.model.model),
    })));
    const connectableNames = new Set(mcpServers.filter(server => !server.configurationError).map(server => server.serverName));
    await mcpPresets.invalidate((previous.mcpServers ?? []).filter(server => server.transport === 'streamable-http' && !connectableNames.has(server.serverName)).map(server => server.serverName));
    // Session-owned stdio processes outlive per-turn prompt/tool configuration.
    // Keep only the same healthy connection; changed configuration/filtering
    // disposes its live definitions and therefore its approval identity.
    const stdioConfigs = new Map(mcpServers.filter(server => !server.configurationError && server.transport !== 'streamable-http')
      .map(server => [server.serverName, { ...server, ...(registrationFilter ? { allowedTools: registrationFilter.allow ?? null, deniedTools: registrationFilter.deny } : {}), failOnStartupError: true }]));
    let localConnections = stdioConnections.get(agent);
    if (!localConnections) { localConnections = new Map(); stdioConnections.set(agent, localConnections); }
    for (const [name, entry] of localConnections) {
      if (entry.fiber.state === 2 && mcpPlugin.mcpConnectionStatus(agent, name) === 'ready' && isDeepStrictEqual(entry.config, stdioConfigs.get(name))) continue;
      localConnections.delete(name);
      await entry.fiber.dispose();
    }
    builtinApprovals.delete(agent);
    await sessionScopes.get(sessionId)?.dispose();
    sessionScopes.delete(sessionId);
    sessionSettings.delete(sessionId);
    const connections = mcpServers.filter(server => server.configurationError).map(server => ({
      serverName: server.serverName, status: 'error', error: server.configurationError,
    }));
    const remoteServers = mcpServers.filter(server => !server.configurationError && server.transport === 'streamable-http');
    let shared;
    let binding = mcpBindings.get(agent);
    const fiber = agent.ctx.isolate('compaction').plugin({
      name: 'codebuddy-session-capabilities',
      async apply(scoped) {
        scoped.effect(() => async () => {
          binding?.rebind(undefined);
          await shared?.[Symbol.asyncDispose]();
        }, 'codebuddy-mcp.preset-lease');
        if (settings.systemPrompt) {
          // Session policy must survive the child's native persona override.
          scoped.systemPrompt.section({ name: 'codebuddy:session-instructions', order: 100, text: settings.systemPrompt, interpolate: false });
        }
        if (settings.conversationLocale) scoped.systemPrompt.section({
          name: 'codebuddy:conversation-locale', order: 103, interpolate: false,
          text: `Default conversation language: ${JSON.stringify(settings.conversationLocale)}. Use it for user-facing replies, progress and delegation messages, unless the human explicitly requests another language. Tell subagents the requested language when delegating. Keep original code, identifiers and tool output unchanged.`,
        });
        for (const tool of settings.tools ?? []) {
          if (registrationFilter && ((registrationFilter.allow && !registrationFilter.allow.includes(tool.name)) || registrationFilter.deny.includes(tool.name))) continue;
          scoped.tools.register({
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
              const context = { sessionId: exec.agent.id, signal: exec.signal, callId: exec.callId };
              const value = await tool.execute(args, settings.projectToolContext ? settings.projectToolContext(context) : context);
              if (Array.isArray(value?.content) && value.content.some(block => block.type === 'image' && !block.attachment)) {
                // Display keeps original bytes; native persistence and model
                // projection use durable references or a backup observation.
                hostImageReceipts.set(exec, value.content);
                try {
                  const content = await ctx.get('codebuddyMcpVision').project(value.content, exec);
                  const images = content.filter(block => block.type === 'image' && !block.attachment);
                  if (images.length) {
                    const route = exec.agent.session.requestHeader()?.config ?? exec.agent.options;
                    const info = await ctx.llm.resolveModelInfo(route.provider, route.model, exec.signal);
                    if (!info.inputModalities?.includes('image')) throw new Error('The model has no confirmed image input');
                    const refs = await admitEncodedImages(ctx.attachments, images.map(block => ({
                      data: block.data, mediaType: block.mimeType ?? block.mediaType,
                    })));
                    let index = 0;
                    exec.signal.throwIfAborted();
                    return { ...value, content: content.map(block => images.includes(block) ? { type: 'image', attachment: refs[index++] } : block) };
                  }
                  exec.signal.throwIfAborted();
                  return { ...value, content };
                } catch (error) {
                  if (exec.signal.aborted) throw error;
                  // The tool action succeeded. Inspection cannot turn it into a
                  // retryable action failure or replace its original receipt.
                  return { ...value, content: value.content.flatMap(block => block.type === 'image'
                    ? [{ type: 'text', text: 'Image inspection is unavailable for this result. The tool action and saved output remain valid. Do not repeat the action just to retry inspection or claim visual details you did not observe.' }]
                    : [block]) };
                }
              }
              return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value ?? null };
            },
          });
          // Only host-authored definitions contribute capabilities here. MCP
          // annotations are remote hints and never grant approval by themselves.
          if (tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false) {
            readOnlyDefinitions.add(scoped.tools.get(tool.name, agent));
          }
          const builtinScope = toolSessionApprovalScope(tool);
          if (builtinScope) builtinDefinitions.set(scoped.tools.get(tool.name, agent), { tool, scope: builtinScope });
        }
        const compactFiber = scoped.plugin(compactionPlugin, {
          thresholdRatio: settings.autoCompactThreshold ?? 0.8,
          // The summary shares the conversation's reasoning mode for cache
          // reuse, so its cap must fit both thinking and the complete checkpoint.
          headroomTokens: 1024, maxTokens: 4096, retainRatio: Math.min(0.16, (settings.autoCompactThreshold ?? 0.8) / 2),
          auto: settings.autoCompact !== false,
        });
        await compactFiber;
        if (compactFiber.state !== 2) throw new Error('Harness compaction did not activate');
        // Both transports are independent. Harness still owns remote preset
        // leases and session-scoped stdio processes; admit the loop after both.
        const [lease, statuses] = await Promise.all([
          mcpPresets.acquire(remoteServers).then(value => (shared = value)),
          Promise.all(mcpServers.filter(server => !server.configurationError && server.transport !== 'streamable-http').map(async server => {
          if (localConnections.has(server.serverName)) return { serverName: server.serverName, status: 'ready' };
          const started = performance.now();
          const config = stdioConfigs.get(server.serverName);
          const connection = agent.ctx.plugin(mcpPlugin, config);
          try {
            await connection;
            if (connection.state !== 2) throw new Error('Connection did not activate');
            localConnections.set(server.serverName, { config: structuredClone(config), fiber: connection });
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
        })),
        ]);
        if (lease) {
          if (binding) binding.rebind(lease.key);
          else { binding = bindScopeParent(agent, lease.key); mcpBindings.set(agent, binding); }
          connections.push(...lease.statuses);
          console.info('[Harness MCP reuse]', JSON.stringify({ sessionId, reused: lease.reused, servers: lease.statuses.length }));
        }
        connections.push(...statuses);
        if (agent.session.header.origin !== 'subagent') {
          for (const definition of installSubagentTemplates(scoped, nativeSubagent, { models: subagentModels, custom: subagentTemplates, allow: settings.toolFilter?.allow, deny: settings.toolFilter?.deny })) delegationDefinitions.add(definition);
        }
        if (settings.toolFilter) restrictSessionTools(scoped, settings.toolFilter, shared?.key);
        const discovery = childFilter?.allow?.length === 0 ? undefined
          : installToolDiscovery(scoped, agent, () => providers.get(agent.options.provider)?.baseURL);
        if (discovery) {
          readOnlyDefinitions.add(discovery);
          // Loading tool schemas is internal plumbing, not a project operation.
          delegationDefinitions.add(discovery);
        }
      },
    });
    try { await fiber; if (fiber.state !== 2) throw new Error('Session capability configuration failed'); }
    catch (error) { await fiber.dispose(); await releaseStdioConnections(agent); throw error; }
    sessionScopes.set(sessionId, fiber);
    sessionSettings.set(sessionId, settings);
    builtinApprovals.set(agent, builtinBindings);
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
    async permissions(sessionId, { cwd: workingDirectory, initialPreset, preset } = {}) {
      if (preset !== undefined) ctx.permissionPresets.resolve(preset);
      if (!ctx.agents.get(sessionId) && workingDirectory) {
        const work = creation.then(async () => {
          if (initialPreset !== undefined) {
            ctx.permissionPresets.resolve(initialPreset);
            initialPermissions.set(sessionId, initialPreset);
          }
          try { await ctx.sessionController.create({ sessionId, cwd: resolve(workingDirectory) }); }
          finally { initialPermissions.delete(sessionId); }
        });
        creation = work.catch(() => {});
        await work;
      }
      const agent = await resolveAgent(sessionId);
      if (preset !== undefined) ctx.permissionPresets.set(agent.session, preset);
      await ctx.sessions.flush(agent.session);
      return {
        preset: ctx.permissionPresets.current(agent.session),
        sandboxMode: ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
        approvalPolicy: ctx.approval.effectivePolicy(agent.session),
      };
    },
    invalidateMcpServers(configKeys) { return mcpPresets.invalidate(configKeys); },
    async warmMcpServers(servers) {
      if (servers.some(server => server.transport !== 'streamable-http')) throw new TypeError('Startup preparation accepts remote MCP connections only');
      const lease = await mcpPresets.acquire(servers);
      try { return lease?.statuses ?? []; }
      finally { await lease?.[Symbol.asyncDispose](); }
    },
    async createSession({ sessionId = randomUUID(), cwd: workingDirectory = cwd, provider, model, options }) {
      const work = creation.then(async () => {
        selection = await configureProvider(provider, model);
        let sessionCwd = resolve(workingDirectory), created;
        if (options?.initialPermissionPreset !== undefined) {
          ctx.permissionPresets.resolve(options.initialPermissionPreset);
          initialPermissions.set(sessionId, options.initialPermissionPreset);
        }
        try { created = await ctx.sessionController.create({ sessionId, cwd: sessionCwd }); }
        catch (error) {
          const recorded = error.details?.existingCwd;
          if (error.code !== 'session/conflict' || error.details?.sessionId !== sessionId || typeof recorded !== 'string') throw error;
          const [requestedTarget, recordedTarget] = await Promise.all([ctx.fs.resolve(sessionCwd), ctx.fs.resolve(recorded)]);
          if (ctx.fs.processPath(requestedTarget) !== ctx.fs.processPath(recordedTarget)) throw error;
          // The controller owns the persisted spelling; aliases must not rewrite it.
          sessionCwd = recorded;
          created = await ctx.sessionController.create({ sessionId, cwd: sessionCwd });
        }
        finally { initialPermissions.delete(sessionId); }
        await ctx.sessionController.selectModel({ sessionId: created.sessionId, ...selection });
        contextSources.set(created.sessionId, provider.contextSource ?? (provider.contextWindow ? 'configured' : 'fallback'));
        await configureSession(created.sessionId, {
          ...options,
          // Model admission replaces the effort; unlike a partial tool update,
          // an omitted effort here must not inherit the previous model's choice.
          thinkingEffort: options?.thinkingEffort,
        });
        return { ...created, cwd: sessionCwd, provider: provider.id, model };
      });
      creation = work.catch(() => {});
      return work;
    },
    async prompt(sessionId, content, { onEvent, onPermission, onToolPolicy, onToolStart, onUserQuestions, signal, requestId = randomUUID(), resumeGoal, createGoal, planMode } = {}) {
      if (runs.has(sessionId)) throw new Error(`Session ${sessionId} already has an active prompt`);
      if (!sessionScopes.has(sessionId)) throw new Error('Configure the session before prompting');
      signal?.throwIfAborted();
      const completion = Promise.withResolvers();
      // Attach rejection observation before admission can synchronously fail.
      completion.promise.catch(() => {});
      const run = { ...completion, onEvent, onPermission, onToolPolicy, onToolStart, onUserQuestions, events: Promise.resolve(), steps: 0, sessionId, requestId };
      runs.set(sessionId, run);
      const cancel = () => { try { driver.cancel(sessionId); } catch { /* Admission may not have opened a turn yet. */ } };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (resumeGoal) {
          const current = ctx.goals.get(await resolveAgent(sessionId));
          if (!current || current.id !== resumeGoal.goalId || current.revision !== resumeGoal.revision) throw new Error('Goal changed before resume; refresh its current state');
          if (current.phase === 'complete' || current.roundsStarted >= current.maxGoalRounds) throw new Error('This goal cannot be resumed with its current round budget');
        }
        if (planMode !== undefined) {
          if (typeof planMode !== 'boolean') throw new TypeError('planMode must be boolean');
          await driver.setPlanMode(sessionId, planMode);
        }
        if (createGoal) {
          const agent = await resolveAgent(sessionId);
          const created = ctx.goals.create(agent, createGoal);
          // Keep new goals dormant until the ordinary prompt owns callbacks,
          // permissions and cancellation. Never start an unobserved round.
          const paused = ctx.goals.pause(agent, { id: created.id, revision: created.revision });
          resumeGoal = { goalId: paused.id, revision: paused.revision };
          await ctx.sessions.flush(agent.session);
        }
        const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        const promptAgent = ctx.agents.get(sessionId);
        if (promptAgent?.inbox.nextTurn.some(message => message.source?.kind === 'subagent-settled'))
          await noticeAdmission.reconcile(promptAgent, signal);
        const parked = promptAgent?.inbox.nextTurn ?? [];
        // A stopped parent's notices must not open a model request before its
        // new human instruction. Native steer joins that instruction with the
        // parked notices through native step admission; mixed human queues retain FIFO.
        const mode = promptAgent?.status === 'idle' && parked.length > 0 && parked.every(message => message.source?.kind === 'subagent-settled') ? 'steer' : 'queue';
        await ctx.sessionController.prompt({ sessionId, requestId, mode, content: parts, clientTimeZone: 'Asia/Shanghai' }, signal ?? new AbortController().signal);
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
        // Idle ends execution, but the native JSONL writer may still batch events.
        // A completed ACP response must survive an immediate process loss.
        await ctx.sessions.flush(agent.session);
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
        try {
          // Cancellation during asynchronous admission may leave this prompt
          // unclaimed. Retire only that cancelled request, using native queue
          // removal (including attachment cleanup); keep other pending work.
          const agent = ctx.agents.get(sessionId);
          if (run.cancelRequested && agent) {
            const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => message.source?.kind === 'user' && message.source.rpcId === requestId);
            for (const message of pending)
              await ctx.sessionController.updateQueue({ sessionId, itemId: message.id, action: { kind: 'remove' } });
            if (pending.length) await ctx.sessions.flush(agent.session);
          }
        } finally {
          runs.delete(sessionId);
          signal?.removeEventListener('abort', cancel);
        }
      }
    },
    configureSession,
    configureSubagentLimits,
    async questions(sessionId) {
      const agent = ctx.agents.get(sessionId);
      return agent ? userQuestions(agent.session) : { nativeSessionId: sessionId, active: [], settled: [] };
    },
    async answerQuestion(sessionId, callId, answer) {
      const run = runs.get(sessionId);
      if (!run || run.cancelRequested) throw new Error('当前轮次已停止或结束，无需再回答。');
      const agent = ctx.agents.get(sessionId);
      if (!agent || !userQuestions(agent.session).active.some(q => q.callId === callId && q.state === 'continued')) return false;
      return ctx.userQuestions.answer(agent, callId, answer);
    },
    extensionStatus(sessionId) {
      const agent = ctx.agents.get(sessionId);
      return (extensionStates.get(sessionId) ?? []).map(state => {
        const status = agent && [...scopeChainOf(agent), ctx.root].map(key => mcpPlugin.mcpConnectionStatus(key, state.serverName)).find(Boolean);
        return status ? { serverName: state.serverName, status, ...(status === 'error' ? { error: 'MCP connection is unavailable or reconnecting.' } : {}) } : structuredClone(state);
      });
    },
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
    async callTool(sessionId, name, args, { onPermission, onToolPolicy, onToolStart, onEvent, signal = new AbortController().signal } = {}) {
      const agent = await resolveAgent(sessionId);
      if (agent.status !== 'idle' || runs.has(sessionId)) throw new Error('Direct tool calls require an idle session');
      const callId = randomUUID();
      const completion = Promise.withResolvers();
      completion.promise.catch(() => {});
      const run = { ...completion, onPermission, onToolPolicy, onToolStart, onEvent, events: Promise.resolve(), sessionId };
      directCalls.set(callId, run);
      try {
        return await agent.runMaintenance(async maintenanceSignal => {
          const metadata = mcpPlugin.getMcpToolMetadata(ctx, agent, name);
          emit(run, { type: 'tool_call', id: callId, name, internalControl: isInternalControl(agent, name), arguments: args, sessionId, ...(metadata?.mcpApp ? { mcpApp: metadata.mcpApp } : {}) });
          const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: AbortSignal.any([signal, maintenanceSignal]) });
          emit(run, { type: 'tool_result', id: callId, result: result.content, isError: result.isError, sessionId, name, arguments: args, structuredContent: result.value, error: result.error, ...run.receipt });
          await run.events;
          return { ...result, ...(run.receipt?.mcpResult ? { mcpResult: run.receipt.mcpResult } : {}),
            ...(run.receipt?.presentationContent ? { presentationContent: run.receipt.presentationContent } : {}),
          };
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
    async listBuiltinSkills(workingDirectory) {
      const options = { cwd: resolve(workingDirectory ?? cwd) };
      const summaries = await ctx.skills.list(options);
      const definitions = await Promise.all(summaries.filter(skill => skill.source === 'bundled')
        .map(skill => ctx.skills.get(skill.name, options)));
      // A concurrent catalog refresh may change the winning provider.
      return definitions.filter(skill => skill?.source === 'bundled');
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
    async getPlanMode(sessionId) { return ctx.planMode.get(await resolveAgent(sessionId)); },
    async setPlanMode(sessionId, active) {
      if (typeof active !== 'boolean') throw new TypeError('Plan mode must be boolean');
      const agent = await resolveAgent(sessionId);
      ctx.planMode.set(agent, active);
      await ctx.sessions.flush(agent.session);
      return ctx.planMode.get(agent);
    },
    async getGoal(sessionId) { return ctx.goals.get(await resolveAgent(sessionId)); },
    async controlGoal(sessionId, { action, goalId, revision, objective }) {
      if (!['pause', 'resume', 'edit', 'clear'].includes(action)) throw new TypeError('Unsupported goal control action');
      if (action === 'resume' && !runs.has(sessionId)) throw new Error('Resume a goal through prompt with resumeGoal so its stream and permissions remain attached');
      const agent = await resolveAgent(sessionId);
      // The UI supplies structured human intent and the official CAS identity.
      // Resume arms the official round driver; this adapter never queues work.
      const goal = action === 'edit'
        ? ctx.goals.edit(agent, { id: goalId, revision }, { objective })
        : ctx.goals[action](agent, { id: goalId, revision });
      await ctx.sessions.flush(agent.session);
      return action === 'clear' ? null : goal;
    },
    async listSessions() { return (await ctx.sessionController.list({}, new AbortController().signal)).items; },
    async history(sessionId) { return ctx.sessionController.inspect(sessionId); },
    async presentationContent(content) {
      return Promise.all(content.map(async block => {
        if (block?.type !== 'image' || !block.attachment) return block;
        try {
          // Read only the verified object owned by the native attachment store;
          // never resolve a tool-provided path or alter the durable receipt.
          const stored = await ctx.attachments.readImage(block.attachment);
          return { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType };
        } catch {
          // Optional preview loss must not drop the tool's real terminal update.
          return { type: 'text', text: 'Image preview is unavailable. The original tool result remains recorded.' };
        }
      }));
    },
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
      if (agent) await releaseStdioConnections(agent);
      if (agent) { builtinApprovals.delete(agent); webApprovals.delete(agent); approvalOwners.delete(agent); }
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
    async *followSubagent(address, signal) {
      for await (const item of ctx.sessionController.follow({ address: { kind: 'subagent', ...address }, assistantStream: true, maxMessages: Number.MAX_SAFE_INTEGER }, signal)) {
        const active = item.type === 'snapshot' && item.assistantStream?.activeAttempt;
        yield active ? { ...item, assistantStream: { activeAttempt: {
          attemptId: active.attemptId, turn: active.turn, step: active.step,
          chunks: expandAssistantStream(active.stream).map(timed => timed.chunk),
        } } } : item;
      }
    },
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
