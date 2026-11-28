// MCP connection adaptation for CodeBuddy's existing Apps protocol. Naming,
// transport policy and connection lifecycle follow dsh-mcp-client (MIT, 0.2.1-alpha.2).
// Official MCP SDK and Harness tool/resource runtimes still own protocol and execution.
import { StreamableHTTPClientTransport, SdkHttpError, specTypeSchemas } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Config as UpstreamConfig, createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_MCP_TIMEOUT_MS, MCP_RESOURCE_TOOL_NAMES } from '../mcp-settings.mjs';
import { McpTaskClient } from './mcp-tasks.mjs';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMcpSessionApprovalScope } from '../tool-session-approval.mjs';
import { agentPolicyFor } from './agent-policy.mjs';
import { mcpDiagnostic } from './mcp-diagnostics.mjs';
import { createNavigationJob } from './code-navigation-job.mjs';
import { abortable } from './abortable.mjs';

const navigationTools = Object.freeze({ overview: 'get_symbols_overview', definition: 'find_symbol', references: 'find_referencing_symbols' });
const navigationServer = 'codebuddy_navigation';

// This entry is reachable only through the driver's private, unprojected scope.
export const privateNavigation = {
  name: 'codebuddy-navigation-connection', inject: ['tools'],
  apply(ctx, config) { return applyConnection(ctx, config, true); },
};
export const Config = Schema.union(UpstreamConfig.list.map(option => Schema.object({
  ...option.dict, toolCallTimeoutMs: Schema.number().min(1).max(2_147_483_647).default(DEFAULT_MCP_TIMEOUT_MS),
  allowedTools: Schema.union([Schema.const(null), Schema.array(String)]).default(null),
  selectedTools: Schema.union([Schema.const(null), Schema.array(String)]).default(null),
  deniedTools: Schema.array(String).default([]),
  displayName: Schema.string().default(''),
  backgroundStart: Schema.boolean().default(false),
  sessionApprovalScope: Schema.union(['tool', 'module']).default('tool'),
})));
export const name = 'codebuddy-mcp-client', inject = ['tools'];
const scopes = new WeakMap(), receipts = new Map();
const resourceViews = new WeakMap();
const desktopReceipts = new WeakMap();
// Suppress repeated initial failures across session preparations. Healthy
// connection recovery remains owned by the existing connection lifecycle.
const startupFailures = new Map();
export function clearMcpStartupFailures(matches) {
  for (const [key, failure] of startupFailures) if (matches(failure.serverName)) startupFailures.delete(key);
}
// Preserve native facts before upstream converts an MCP error into plain Error.
// Each invocation is consumed once; this transport layer makes no policy decision.
export function takeDesktopControlReceipt(exec) {
  const receipt = desktopReceipts.get(exec);
  desktopReceipts.delete(exec);
  return receipt;
}
const clone = value => structuredClone(value);
const MAX_META_BYTES = 16 * 1024 * 1024;

export const mcpConnectionStatus = (scope, serverName) => scopes.get(scope)?.get(serverName)?.status;
export const mcpConnectionError = (scope, serverName) => scopes.get(scope)?.get(serverName)?.error;

// Only the caller's selected scope chain is visible. A pending transport is not
// an executable tool and never contributes an approval until its handshake ends.
function visibleConnections(agent) {
  const entries = new Map();
  for (const key of scopeChainOf(agent)) for (const [name, entry] of scopes.get(key) ?? []) {
    if (!entries.has(name) && agentPolicyFor(agent).every(policy => policy.mcpServers.includes(name))) entries.set(name, entry);
  }
  return entries;
}
export function mcpServerStates(agent) {
  return [...visibleConnections(agent)].map(([serverName, entry]) => ({ serverName, status: entry.status, ...(entry.error ? { error: entry.error } : {}) }));
}
export function pendingMcpServers(agent) {
  return [...visibleConnections(agent)].filter(([, entry]) => entry.status === 'connecting').map(([name]) => name);
}
export async function waitForMcpServers(agent, names, signal) {
  signal?.throwIfAborted();
  const entries = visibleConnections(agent);
  const waits = names.map(name => entries.get(name)?.ready).filter(Boolean);
  if (!waits.length) return;
  let abort;
  try {
    await Promise.race([Promise.all(waits), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
    })]);
    signal?.throwIfAborted();
  } finally { if (abort) signal?.removeEventListener('abort', abort); }
}


// A session borrows the connection's exact definitions and receipt identities.
// Harness owns both scopes; this view neither opens a transport nor replays calls.
export function projectMcpConnection(ctx, source, serverName) {
  const entry = scopes.get(source)?.get(serverName);
  if (!entry) return;
  const owner = scopeOf(ctx);
  let registry = scopes.get(owner);
  if (!registry) { registry = new Map(); scopes.set(owner, registry); }
  if (registry.has(serverName)) throw Error(`Duplicate MCP projection: ${serverName}`);
  registry.set(serverName, entry);
  const registrations = new Map();
  let disposed = false, pending = false;
  const refresh = () => {
    if (disposed) return;
    for (const [name, current] of registrations) {
      if (entry.snapshots.get(name)?.definition === current.definition) continue;
      current.dispose(); registrations.delete(name);
    }
    for (const [name, snapshot] of entry.snapshots) if (!registrations.has(name))
      registrations.set(name, { definition: snapshot.definition, dispose: ctx.tools.register(snapshot.definition) });
  };
  // Source tools/change is synchronous and can precede its completed catalog swap.
  ctx.on('tools/change', () => {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(() => { pending = false; refresh(); });
  }, { global: true });
  ctx.effect(() => () => {
    disposed = true; registry.delete(serverName);
    for (const current of registrations.values()) current.dispose();
    registrations.clear();
  });
  if (entry.resources) ctx.inject(['mcpResources'], inner => {
    inner.mcpResources.register(serverName, entry.resources);
    let views = resourceViews.get(owner);
    if (!views) { views = new Map(); resourceViews.set(owner, views); }
    // Harness creates resource tools per scope. Validate the view's definition,
    // but keep consent bound to the source connection's live generation.
    views.set(serverName, new Map([...entry.resourceDefinitions.keys()].map(name => [name, inner.tools.get(name, owner)])));
    inner.effect(() => () => views.delete(serverName));
  });
  ctx.inject(['systemPrompt'], inner => inner.systemPrompt.section({
    name: `mcp:${serverName}`, order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false,
    text: ({ scope }) => agentPolicyFor(scope).every(policy => policy.mcpServers.includes(serverName)) ? entry.instructions() : '',
  }));
  refresh();
}

function renewApprovalGroup(entry, serverName, displayName) {
  const group = Object.freeze({ kind: 'mcp_module', name: serverName, displayName: displayName?.trim().slice(0, 160) || serverName, identity: Object.freeze({}) });
  entry.approvalGroup = group;
  for (const bindings of [entry.approvals, entry.resourceApprovals])
    for (const [name, binding] of bindings) bindings.set(name, { ...binding, group });
  return group;
}

// Revoke only the edited module, including late answers against still-leased
// connections. Connection disposal and reconnect remain owned by the registry.
export function invalidateMcpApprovals(scope, matches) {
  for (const [name, entry] of scopes.get(scope) ?? [])
    if (matches(name) && entry.approvalGroup) renewApprovalGroup(entry, name, entry.approvalGroup.displayName);
}

function sessionExpired(error) {
  if (!(error instanceof SdkHttpError)) return false;
  if (error.status === 404) return true;
  // Legacy servers sometimes use HTTP 400 for this exact JSON-RPC rejection.
  // Generic invalid requests, authentication errors and tool text are not expiry.
  if (error.status !== 400) return false;
  try {
    const body = JSON.parse(error.data.text);
    return body.jsonrpc === '2.0' && body.error?.code === -32600 && body.error.message === 'Session not found';
  } catch { return false; }
}

function publicName(server, raw) {
  const joined = `mcp__${server}__${raw}`, normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined === normalized && normalized.length <= 64) return joined;
  const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}
function appMetadata(server, tool) {
  const uri = tool._meta?.ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? { resourceUri: uri, extensionName: server, toolName: tool.name } : undefined;
}
export function getMcpToolMetadata(ctx, agent, name) {
  for (const key of [...scopeChainOf(agent), ctx.root]) {
    const registry = scopes.get(key);
    if (!registry) continue;
    for (const entry of registry.values()) if (entry.tools.has(name)) return clone(entry.tools.get(name));
  }
}
// A grant binds the live registered definition, not its public name or remote hints.
export function getMcpSessionApproval(ctx, agent, name) {
  const definition = ctx.tools.get(name, agent);
  for (const key of [...scopeChainOf(agent), ctx.root]) {
    const registry = scopes.get(key);
    if (!registry) continue;
    for (const entry of registry.values()) {
      const binding = entry.approvals.get(name);
      if (binding && binding.definition === definition && binding.live()) return binding;
    }
  }
}
export function getMcpBusinessSessionApproval(ctx, agent, name, scope) {
  if (!isMcpSessionApprovalScope(scope)) return undefined;
  const definition = ctx.tools.get(name, agent);
  for (const key of [...scopeChainOf(agent), ctx.root]) {
    const registry = scopes.get(key);
    if (!registry) continue;
    for (const entry of registry.values()) {
      const binding = entry.approvals.get(name);
      if (!binding || binding.definition !== definition || !binding.live() || !scope.accepts(entry.config)) continue;
      const members = scope.tools.map(raw => [publicName(entry.config.serverName, raw), raw])
        .filter(([member]) => entry.approvals.has(member));
      if (!members.some(([member]) => member === name)) return undefined;
      const bindings = members.map(([member]) => entry.approvals.get(member));
      entry.businessApprovals ??= new Map();
      let group = entry.businessApprovals.get(scope.business.id);
      if (!group || group.scope.key !== scope.key || bindings.length !== group.bindings.length ||
          bindings.some((value, index) => value !== group.bindings[index])) {
        group = { scope, bindings, identity: Object.freeze({}),
          presentation: Object.freeze({ ...scope.business, tools: members.map(([, raw]) => raw) }) };
        entry.businessApprovals.set(scope.business.id, group);
      }
      return { identity: group.identity, presentation: group.presentation,
        isCurrent: () => entry.businessApprovals.get(scope.business.id) === group && binding.live() && scope.accepts(entry.config) &&
          members.every(([member], index) => entry.approvals.get(member) === bindings[index]) };
    }
  }
}
export function getMcpResourceSessionApproval(ctx, agent, name, server) {
  if (!MCP_RESOURCE_TOOL_NAMES.includes(name)) return undefined;
  const definition = ctx.tools.get(name, agent);
  for (const key of [...scopeChainOf(agent), ctx.root]) {
    const entry = scopes.get(key)?.get(server);
    if (!entry) continue;
    const binding = entry.resourceApprovals.get(name);
    // Resolve the nearest provider, never fall through to another connection
    // with the same name. Shared resource tools still bind each server separately.
    const expected = resourceViews.get(key)?.get(server)?.get(name) ?? binding?.definition;
    return binding && expected === definition && binding.live() ? binding : undefined;
  }
}
/** Consume an exact invocation receipt; policies and canonical failures remain authoritative. */
export function takeMcpResultMetadata(exec, result) {
  const receipt = receipts.get(exec.token); receipts.delete(exec.token);
  if (!receipt || result.isError || !isDeepStrictEqual(result.value, receipt.canonical) || !isDeepStrictEqual(result.content, receipt.presentation)) return {};
  return { mcpResult: clone(receipt.result), mcpSource: clone(receipt.source), ...(receipt.mcpApp ? { mcpApp: clone(receipt.mcpApp) } : {}) };
}

export async function apply(ctx, config) { return applyConnection(ctx, config, false); }

async function applyConnection(ctx, config, navigation) {
  if (navigation && (config.transport !== 'stdio' || config.serverName !== navigationServer)) throw Error('Invalid private navigation connection');
  const failureKey = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const recent = startupFailures.get(failureKey);
  if (!navigation && config.failOnStartupError && recent && Date.now() - recent.at < 30_000) throw Error(recent.error);
  if (!navigation) startupFailures.delete(failureKey);
  const allowedTools = config.allowedTools ?? null, deniedTools = config.deniedTools ?? [];
  const owner = scopeOf(ctx) ?? ctx.root;
  let registry = scopes.get(owner);
  if (!registry) { registry = new Map(); scopes.set(owner, registry); }
  if (registry.has(config.serverName)) throw Error(`MCP server ${config.serverName} is already registered in this scope`);
  const entry = { config, tools: new Map(), approvals: new Map(), snapshots: new Map(), resourceDefinitions: new Map(), resourceApprovals: new Map(), status: 'connecting' }; registry.set(config.serverName, entry);
  const policy = { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10, ...config.reconnect };
  if (![policy.initialDelayMs, policy.maxDelayMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) || policy.initialDelayMs > policy.maxDelayMs || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw Error('Invalid MCP reconnect policy');
  const timeout = config.toolCallTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  let disposed = false, generation, stopping, retryTimer, failures = 0, connectedAt, instructions = '', sync = Promise.resolve(), attempt = Promise.resolve();
  entry.instructions = () => instructions;
  let registrations = [];
  function clearTools() { for (const dispose of registrations) dispose(); registrations = []; entry.tools.clear(); entry.approvals.clear(); entry.snapshots.clear(); }
  const live = current => Boolean(current && !disposed && generation === current && current.ready && !current.down && !current.startupAbort?.signal.aborted);
  async function synchronize(current) {
    const next = sync.then(async () => {
      if (disposed || generation !== current || current.down) return;
      const response = current.client.getServerCapabilities()?.tools === undefined ? { tools: [] } : await current.client.listTools(undefined, { cacheMode: 'refresh', timeout,
        ...(navigation ? { signal: current.startupAbort.signal } : {}) });
      if (disposed || generation !== current || current.down) return;
      if (navigation) {
        current.navigationSchemas = new Map(Object.values(navigationTools).map(name => {
          const tool = response.tools.find(tool => tool.name === name);
          if (!tool) throw Error(`Code navigation server lacks ${name}`);
          return [name, tool];
        }));
        return;
      }
      const definitions = new Map(), metadata = new Map(), approvals = new Map(), snapshots = new Map();
      for (const tool of response.tools) {
        // User selection uses server-native names; role filters below use public names.
        if (config.selectedTools !== null && config.selectedTools !== undefined && !config.selectedTools.includes(tool.name)) continue;
        const name = publicName(config.serverName, tool.name), mcpApp = appMetadata(config.serverName, tool);
        if ((allowedTools !== null && !allowedTools.includes(name)) || deniedTools.includes(name)) continue;
        if (definitions.has(name)) throw Error(`Duplicate MCP tool: ${tool.name}`);
        // Reuse unchanged definitions within this connection. Module consent
        // below still follows the entire catalog, including added/removed tools.
        const previous = entry.snapshots.get(name);
        if (previous?.current === current && isDeepStrictEqual(previous.source, tool)) {
          definitions.set(name, previous.definition);
          metadata.set(name, entry.tools.get(name));
          if (entry.approvals.has(name)) approvals.set(name, entry.approvals.get(name));
          snapshots.set(name, previous);
          continue;
        }
        const definition = createMcpToolDefinition(ctx, {
          name, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          async call(args, exec) {
            if (!live(current)) throw Error(`MCP server ${config.serverName} is disconnected`);
            const metadata = await ctx.get('codebuddyMcpRequestMetadata')?.get(config.serverName, exec);
            const raw = await current.client.callTool({ name: tool.name, arguments: args, ...(metadata ? { _meta: metadata } : {}) }, { signal: exec.signal, timeout, toolDefinition: tool });
            // Takeover fences observation too, before an auxiliary vision model
            // can receive a screenshot returned by an already-running request.
            if (config.serverName === 'qwen_computer') await ctx.get('codebuddyMcpRequestMetadata')?.get(config.serverName, exec);
            const parsed = specTypeSchemas.CallToolResult['~standard'].validate(raw);
            if (!parsed.issues && config.serverName === 'qwen_computer')
              desktopReceipts.set(exec, clone(parsed.value.structuredContent?.desktop_control));
            if (!parsed.issues && !parsed.value.isError) {
              const result = parsed.value;
              if (Buffer.byteLength(JSON.stringify(result)) > MAX_META_BYTES) throw Error('MCP tool result exceeds the host app limit');
              let content = result.content;
              if (content.some(block => block.type === 'image')) {
                const desktopObservation = config.serverName === 'qwen_computer' ? result.structuredContent?.desktop_observation : undefined;
                // Control-first observations also cover apps with buttons but no
                // writable fields. Keep the frame in the receipt; the main model
                // can request full when control evidence is insufficient.
                try {
                  if ((desktopObservation?.view === 'fields' || desktopObservation?.has_field_readback === true) && desktopObservation.schema_version === 1 &&
                      Number.isSafeInteger(desktopObservation.pid) && desktopObservation.pid > 0 &&
                      Number.isSafeInteger(desktopObservation.window_handle) && desktopObservation.window_handle > 0 &&
                      content.some(block => block.type === 'text' && block.text?.trim())) {
                    content = content.filter(block => block.type !== 'image');
                  } else {
                    content = await ctx.get('codebuddyMcpVision')?.project(content, exec, desktopObservation) ?? content;
                  }
                }
                catch (error) {
                  if (exec.signal.aborted) throw error;
                  ctx.get('codebuddyMcpVision')?.unavailable?.(exec, { extensionName: config.serverName, toolName: tool.name });
                  // The upstream action already happened. An observer outage
                  // must not turn a successful action into a retryable failure.
                  content = content.map(block => block.type === 'image' ? { type: 'text', text: '[auxiliary image observation unavailable; the tool action receipt is unchanged. Do not repeat an action to retry image interpretation. The tool returned an image, but this model did not receive usable visual content. This is a model/auxiliary vision routing problem, not evidence of missing macOS Screen Recording permission. Select a confirmed image-capable model or configure auxiliary vision, then observe again before further visual actions. Do not guess coordinates or claim a message was sent or read without visible evidence.]' } : block);
                }
              }
              const canonical = { content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
              receipts.set(exec.token, { result: clone(result), canonical, mcpApp, source: { extensionName: config.serverName, toolName: tool.name } });
              return { ...result, content };
            }
            return raw;
          },
        });
        const projectContent = definition.projectContent;
        definition.projectContent = (exec, result) => {
          const projected = projectContent?.(exec, result), receipt = receipts.get(exec.token);
          if (receipt) receipt.presentation = clone(projected ?? result.content);
          return projected;
        };
        definitions.set(name, definition);
        snapshots.set(name, { current, source: clone(tool), definition });
        metadata.set(name, { ...(tool._meta ? { _meta: clone(tool._meta) } : {}), ...(tool.outputSchema ? { outputSchema: clone(tool.outputSchema) } : {}), ...(mcpApp ? { mcpApp } : {}), extensionName: config.serverName, rawName: tool.name });
        // This only offers an explicit user choice; annotations never auto-grant.
        if (tool.annotations?.destructiveHint !== true) approvals.set(name, {
          definition, identity: Object.freeze({}), live: () => live(current),
          extensionSource: config.transport === 'streamable-http' ? 'external_http' : 'external_stdio',
        });
      }
      if (config.sessionApprovalScope === 'module') {
        // A module grant covers this exact live catalog, never a future tool or
        // a same-name replacement connection. Unchanged refreshes retain it.
        const unchanged = entry.approvalGeneration === current && snapshots.size === entry.snapshots.size &&
          [...snapshots].every(([name, snapshot]) => entry.snapshots.get(name) === snapshot);
        const group = unchanged && entry.approvalGroup ? entry.approvalGroup :
          renewApprovalGroup(entry, config.serverName, config.displayName);
        entry.approvalGroup = group;
        entry.approvalGeneration = current;
        for (const [name, binding] of approvals)
          if (binding.group !== group) approvals.set(name, { ...binding, group });
      }
      clearTools();
      try { for (const definition of definitions.values()) registrations.push(ctx.tools.register(definition)); entry.tools = metadata; entry.approvals = approvals; entry.snapshots = snapshots; }
      catch (error) { clearTools(); throw error; }
    });
    sync = next.catch(() => {}); return next;
  }
  async function closeGeneration(current) {
    if (!current) return true;
    if (current.closing) return current.closing;
    if (current.navigationJob) {
      current.startupAbort.abort();
      current.closing = current.navigationJob.close(async () => {
        const closing = current.client.transport ? current.client.close() : current.transport.close();
        await Promise.allSettled([closing, current.connection]);
        // A cancelled handshake must not relink a transport after the close.
        if (current.client.transport) await current.client.close();
      });
      return current.closing;
    }
    current.closing = (async () => {
      let timer;
      try {
        const closed = await Promise.race([
          (async () => { await (current.client.transport ? current.client.close() : current.transport.close()); return true; })(),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); timer.unref(); }),
        ]);
        return closed && (current.closed || !current.client.transport);
      } catch { return current.closed; } finally { clearTimeout(timer); }
    })();
    return current.closing;
  }
  function disconnected(current) {
    if (disposed || generation !== current || current.down) return;
    current.down = true; current.ready = false; instructions = '';
    clearTools();
    entry.status = 'error';
    if (connectedAt && Date.now() - connectedAt >= policy.maxDelayMs) failures = 0;
    connectedAt = undefined;
    if (!policy.enabled || ++failures > policy.maxAttempts) { clearTools(); return; }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      attempt = (async () => { if (await closeGeneration(current)) return connect(false); clearTools(); ctx.logger.error('MCP reconnect stopped because transport closure was not confirmed'); })();
      entry.ready = attempt.catch(() => {});
      attempt.catch(error => ctx.logger.warn(`MCP reconnect failed: ${String(error)}`));
    }, Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failures - 1)));
    retryTimer.unref();
  }
  async function connect(startup) {
    if (disposed) return;
    entry.status = 'connecting';
    entry.error = undefined;
    const started = performance.now(), phases = {};
    // Session identity belongs to the transport handshake, never saved headers.
    const headers = new Headers(config.headers ?? {});
    headers.delete('mcp-session-id');
    let navigationJob;
    try { navigationJob = navigation ? createNavigationJob() : undefined; }
    catch (error) { entry.status = 'error'; entry.error = mcpDiagnostic(error, config); throw error; }
    const transport = config.transport === 'stdio' ? new StdioClientTransport({ command: config.command,
      args: navigationJob ? [...config.args, '--job', navigationJob.name] : config.args ?? [],
      env: { ...scrubbedParentEnv(), ...config.env }, cwd: config.cwd, stderr: 'pipe' }) : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    let startupStderr = '';
    transport.stderr?.on('data', chunk => { startupStderr = (startupStderr + chunk.toString()).slice(-8192); });
    const current = { transport, ready: false, closed: false, connecting: true, navigationJob,
      ...(navigation ? { startupAbort: new AbortController(), navigationTail: Promise.resolve() } : {}) };
    if (navigationJob) {
      const start = transport.start.bind(transport);
      transport.start = async () => {
        navigationJob.beginRoot();
        let tracked = false;
        const track = () => {
          if (!tracked && transport.pid) { navigationJob.trackRoot(transport.pid); tracked = true; }
        };
        const starting = start();
        try { track(); await starting; }
        finally {
          track();
          if (!tracked) navigationJob.rootStartSettledWithoutPid();
        }
      };
    }
    current.client = new McpTaskClient({ name: 'codebuddy-harness-mcp', version: '0.1.0' }, {
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {}, 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
      versionNegotiation: { mode: navigation ? 'legacy' : 'auto' },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => { synchronize(current).catch(error => ctx.logger.warn(`MCP tool refresh failed: ${String(error)}`)); } } },
    });
    generation = current;
    current.client.onclose = () => { current.closed = true; if (!current.connecting) disconnected(current); };
    current.client.onerror = error => {
      // Reconnect once per generation; never replay an invocation (including
      // Tasks polling failures). The original request retains its actual error.
      if (!current.connecting && transport.sessionId && sessionExpired(error)) disconnected(current);
    };
    try {
      current.connection = current.client.connect(transport, { timeout, ...(navigation ? { signal: current.startupAbort.signal } : {}) });
      await current.connection;
      phases.initializeMs = Math.round(performance.now() - started);
      if (disposed || generation !== current || current.closed || current.down || current.startupAbort?.signal.aborted) throw Error('MCP connection closed during startup');
      const text = navigation ? '' : current.client.getInstructions()?.trimEnd() ?? '';
      const contribution = text ? `### MCP server: ${config.serverName}\n\n${text}` : '';
      if (Buffer.byteLength(contribution) > (config.maxInstructionBytes ?? 32768)) throw Error('MCP instructions exceed configured limit');
      const discoveryStarted = performance.now();
      await synchronize(current);
      phases.toolsListMs = Math.round(performance.now() - discoveryStarted);
      if (disposed || generation !== current || current.closed || current.down || current.startupAbort?.signal.aborted) throw Error('MCP connection closed during tool discovery');
      current.ready = true; current.connecting = false; connectedAt = Date.now(); instructions = contribution; entry.status = 'ready';
      entry.resourceApprovals = new Map([...entry.resourceDefinitions].map(([name, definition]) => [name, {
        definition, identity: Object.freeze({}), live: () => live(current),
        group: entry.approvalGroup,
        extensionSource: config.transport === 'streamable-http' ? 'external_http' : 'external_stdio',
      }]));
    } catch (error) {
      entry.status = 'error';
      entry.error = mcpDiagnostic(error, config, startupStderr);
      const closed = await closeGeneration(current);
      current.connecting = false;
      // Scope removal/closure is cancellation, not a server startup failure.
      // Do not poison an immediate re-add with the failure cooldown.
      if (disposed) return;
      if (startup && config.failOnStartupError) {
        // Initial failure is terminal until an explicit retry/reconfiguration.
        // Background activation must not turn it into a reconnect loop.
        current.down = true; current.ready = false; clearTools();
        const diagnostic = mcpDiagnostic(error, config, startupStderr);
        if (!navigation) {
          startupFailures.set(failureKey, { serverName: config.serverName, at: Date.now(), error: diagnostic });
          while (startupFailures.size > 64) startupFailures.delete(startupFailures.keys().next().value);
        }
        throw Error(diagnostic);
      }
      if (closed) disconnected(current);
      else { current.down = true; clearTools(); }
    } finally {
      console.info('[Harness MCP connection]', JSON.stringify({ serverName: config.serverName, transport: config.transport, ...phases, elapsedMs: Math.round(performance.now() - started), status: entry.status }));
    }
  }
  async function dispose() {
    if (stopping) return stopping;
    disposed = true; clearTimeout(retryTimer); instructions = ''; registry.delete(config.serverName);
    stopping = (async () => {
      if (!await closeGeneration(generation)) {
        if (navigation) throw Error('Code navigation closure could not be confirmed');
        ctx.logger.error('MCP transport closure was not confirmed during disposal');
      }
      await attempt.catch(() => {}); await sync; clearTools();
    })();
    return stopping;
  }
  ctx.effect(() => dispose, 'codebuddy-mcp.connection');
  ctx.on('internal/plugin', fiber => fiber === ctx.fiber && fiber.uid === null ? dispose() : undefined, { global: true });
  if (navigation) entry.navigation = {
    close: dispose,
    get ready() { return live(generation); },
    get retired() { return disposed || entry.status === 'error' || Boolean(generation?.down); },
    async request(operation, args, signal) {
      if (!Object.hasOwn(navigationTools, operation)) throw Error('Unsupported code navigation operation');
      signal?.throwIfAborted();
      try { await (signal ? abortable(entry.ready, signal) : entry.ready); }
      catch (error) {
        if (generation && !live(generation)) { disconnected(generation); await closeGeneration(generation); }
        throw error;
      }
      const current = generation;
      if (!live(current)) throw Error(entry.error ?? 'Code navigation connection is unavailable');
      const query = current.navigationTail.then(async () => {
        signal?.throwIfAborted();
        if (!live(current)) throw Error('Code navigation connection was retired');
        const rawName = navigationTools[operation];
        const deadline = AbortSignal.timeout(timeout);
        const callSignal = AbortSignal.any([current.startupAbort.signal, deadline, ...(signal ? [signal] : [])]);
        try {
          return await current.client.callTool({ name: rawName, arguments: args },
            { signal: callSignal, timeout, toolDefinition: current.navigationSchemas.get(rawName) });
        } catch (error) {
          // A cancelled MCP Future may leave the Serena thread running. Retire
          // the exact generation and prove its range closed before reconnect.
          disconnected(current);
          if (!await closeGeneration(current)) entry.error = 'Code navigation closure could not be confirmed';
          throw error;
        }
      });
      current.navigationTail = query.catch(() => {});
      return query;
    },
  };
  const resourcesAllowed = !navigation && MCP_RESOURCE_TOOL_NAMES
    .some(name => (allowedTools === null || allowedTools.includes(name)) && !deniedTools.includes(name));
  if (resourcesAllowed) entry.resources = { async request(request, exec) {
    const current = generation;
    if (!live(current)) throw Error(`MCP server ${config.serverName} is disconnected`);
    const options = { signal: exec.signal, timeout };
    if (request.method === 'resources/list') return current.client.getServerCapabilities()?.resources === undefined ? { resources: [] } : current.client.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options);
    if (request.method === 'resources/templates/list') return current.client.getServerCapabilities()?.resources === undefined ? { resourceTemplates: [] } : current.client.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options);
    if (request.method === 'resources/read') return current.client.readResource({ uri: request.uri }, options);
    throw Error('Unsupported MCP resource operation');
  } };
  if (entry.resources) ctx.inject(['mcpResources'], inner => { inner.mcpResources.register(config.serverName, entry.resources);
    for (const name of MCP_RESOURCE_TOOL_NAMES) {
      if ((allowedTools !== null && !allowedTools.includes(name)) || deniedTools.includes(name)) continue;
      const definition = inner.tools.get(name, owner);
      if (definition) entry.resourceDefinitions.set(name, definition);
    }
  });
  if (!navigation) ctx.inject(['systemPrompt'], inner => { inner.systemPrompt.section({ name: `mcp:${config.serverName}`, order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false,
    text: ({ scope }) => agentPolicyFor(scope).every(policy => policy.mcpServers.includes(config.serverName)) ? instructions : '' }); });
  // Publish the private close capability before anything can spawn. Even if
  // Cordis unloads a failed plugin, its owner retains the actual close result.
  if (navigation) config.onConnection(entry.navigation);
  attempt = connect(true);
  entry.ready = attempt.catch(() => {});
  if (config.backgroundStart) return;
  try { await attempt; } catch (error) { await dispose(); throw error; }
}
