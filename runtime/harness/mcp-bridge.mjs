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

export const Config = Schema.union(UpstreamConfig.list.map(option => Schema.object({
  ...option.dict, toolCallTimeoutMs: Schema.number().min(1).max(2_147_483_647).default(DEFAULT_MCP_TIMEOUT_MS),
  allowedTools: Schema.union([Schema.const(null), Schema.array(String)]).default(null),
  deniedTools: Schema.array(String).default([]),
})));
export const name = 'codebuddy-mcp-client', inject = ['tools'];
const scopes = new WeakMap(), receipts = new Map();
const clone = value => structuredClone(value);
const MAX_META_BYTES = 16 * 1024 * 1024;

export const mcpConnectionStatus = (scope, serverName) => scopes.get(scope)?.get(serverName)?.status;

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
export function getMcpResourceSessionApproval(ctx, agent, name, server) {
  if (!MCP_RESOURCE_TOOL_NAMES.includes(name)) return undefined;
  const definition = ctx.tools.get(name, agent);
  for (const key of [...scopeChainOf(agent), ctx.root]) {
    const entry = scopes.get(key)?.get(server);
    if (!entry) continue;
    const binding = entry.resourceApprovals.get(name);
    // Resolve the nearest provider, never fall through to another connection
    // with the same name. Shared resource tools still bind each server separately.
    return binding && binding.definition === definition && binding.live() ? binding : undefined;
  }
}
/** Consume an exact invocation receipt; policies and canonical failures remain authoritative. */
export function takeMcpResultMetadata(exec, result) {
  const receipt = receipts.get(exec.token); receipts.delete(exec.token);
  if (!receipt || result.isError || !isDeepStrictEqual(result.value, receipt.canonical) || !isDeepStrictEqual(result.content, receipt.presentation)) return {};
  return { mcpResult: clone(receipt.result), mcpSource: clone(receipt.source), ...(receipt.mcpApp ? { mcpApp: clone(receipt.mcpApp) } : {}) };
}

export async function apply(ctx, config) {
  const allowedTools = config.allowedTools ?? null, deniedTools = config.deniedTools ?? [];
  const owner = scopeOf(ctx) ?? ctx.root;
  let registry = scopes.get(owner);
  if (!registry) { registry = new Map(); scopes.set(owner, registry); }
  if (registry.has(config.serverName)) throw Error(`MCP server ${config.serverName} is already registered in this scope`);
  const entry = { tools: new Map(), approvals: new Map(), snapshots: new Map(), resourceDefinitions: new Map(), resourceApprovals: new Map(), status: 'error' }; registry.set(config.serverName, entry);
  const policy = { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10, ...config.reconnect };
  if (![policy.initialDelayMs, policy.maxDelayMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) || policy.initialDelayMs > policy.maxDelayMs || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw Error('Invalid MCP reconnect policy');
  const timeout = config.toolCallTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  let disposed = false, generation, stopping, retryTimer, failures = 0, connectedAt, instructions = '', sync = Promise.resolve(), attempt = Promise.resolve();
  let registrations = [];
  function clearTools() { for (const dispose of registrations) dispose(); registrations = []; entry.tools.clear(); entry.approvals.clear(); entry.snapshots.clear(); }
  const live = current => !disposed && generation === current && current.ready;
  async function synchronize(current) {
    const next = sync.then(async () => {
      if (disposed || generation !== current || current.down) return;
      const response = current.client.getServerCapabilities()?.tools === undefined ? { tools: [] } : await current.client.listTools(undefined, { cacheMode: 'refresh', timeout });
      if (disposed || generation !== current || current.down) return;
      const definitions = new Map(), metadata = new Map(), approvals = new Map(), snapshots = new Map();
      for (const tool of response.tools) {
        const name = publicName(config.serverName, tool.name), mcpApp = appMetadata(config.serverName, tool);
        if ((allowedTools !== null && !allowedTools.includes(name)) || deniedTools.includes(name)) continue;
        if (definitions.has(name)) throw Error(`Duplicate MCP tool: ${tool.name}`);
        // An unrelated list update must not revoke an unchanged tool's grant.
        // Reconnects and any definition/metadata change still get a new identity.
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
            const parsed = specTypeSchemas.CallToolResult['~standard'].validate(raw);
            if (!parsed.issues && !parsed.value.isError) {
              const result = parsed.value;
              if (Buffer.byteLength(JSON.stringify(result)) > MAX_META_BYTES) throw Error('MCP tool result exceeds the host app limit');
              let content = result.content;
              if (content.some(block => block.type === 'image')) {
                try { content = await ctx.get('codebuddyMcpVision')?.project(content, exec) ?? content; }
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
      clearTools();
      try { for (const definition of definitions.values()) registrations.push(ctx.tools.register(definition)); entry.tools = metadata; entry.approvals = approvals; entry.snapshots = snapshots; }
      catch (error) { clearTools(); throw error; }
    });
    sync = next.catch(() => {}); return next;
  }
  async function closeGeneration(current) {
    if (!current) return true;
    if (current.closing) return current.closing;
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
    entry.status = 'error';
    if (connectedAt && Date.now() - connectedAt >= policy.maxDelayMs) failures = 0;
    connectedAt = undefined;
    if (!policy.enabled || ++failures > policy.maxAttempts) { clearTools(); return; }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      attempt = (async () => { if (await closeGeneration(current)) return connect(false); clearTools(); ctx.logger.error('MCP reconnect stopped because transport closure was not confirmed'); })();
      attempt.catch(error => ctx.logger.warn(`MCP reconnect failed: ${String(error)}`));
    }, Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failures - 1)));
    retryTimer.unref();
  }
  async function connect(startup) {
    if (disposed) return;
    // Session identity belongs to the transport handshake, never saved headers.
    const headers = new Headers(config.headers ?? {});
    headers.delete('mcp-session-id');
    const transport = config.transport === 'stdio' ? new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...scrubbedParentEnv(), ...config.env }, cwd: config.cwd }) : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    const current = { transport, ready: false, closed: false, connecting: true };
    current.client = new McpTaskClient({ name: 'codebuddy-harness-mcp', version: '0.1.0' }, {
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {}, 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
      versionNegotiation: { mode: 'auto' },
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
      await current.client.connect(transport, { timeout });
      if (disposed || generation !== current || current.closed) throw Error('MCP connection closed during startup');
      const text = current.client.getInstructions()?.trimEnd() ?? '';
      const contribution = text ? `### MCP server: ${config.serverName}\n\n${text}` : '';
      if (Buffer.byteLength(contribution) > (config.maxInstructionBytes ?? 32768)) throw Error('MCP instructions exceed configured limit');
      await synchronize(current);
      if (disposed || current.closed) throw Error('MCP connection closed during tool discovery');
      current.ready = true; current.connecting = false; connectedAt = Date.now(); instructions = contribution; entry.status = 'ready';
      entry.resourceApprovals = new Map([...entry.resourceDefinitions].map(([name, definition]) => [name, {
        definition, identity: Object.freeze({}), live: () => live(current),
        extensionSource: config.transport === 'streamable-http' ? 'external_http' : 'external_stdio',
      }]));
    } catch (error) {
      current.connecting = false;
      if (await closeGeneration(current)) disconnected(current);
      else { current.down = true; clearTools(); }
      if (startup && config.failOnStartupError) throw Error(`MCP ${config.serverName}: initial connection or tool discovery failed`, { cause: error });
    }
  }
  async function dispose() {
    if (stopping) return stopping;
    disposed = true; clearTimeout(retryTimer); instructions = ''; registry.delete(config.serverName);
    stopping = (async () => {
      if (!await closeGeneration(generation)) ctx.logger.error('MCP transport closure was not confirmed during disposal');
      await attempt.catch(() => {}); await sync; clearTools();
    })();
    return stopping;
  }
  ctx.effect(() => dispose, 'codebuddy-mcp.connection');
  ctx.on('internal/plugin', fiber => fiber === ctx.fiber && fiber.uid === null ? dispose() : undefined, { global: true });
  const resourcesAllowed = MCP_RESOURCE_TOOL_NAMES
    .some(name => (allowedTools === null || allowedTools.includes(name)) && !deniedTools.includes(name));
  if (resourcesAllowed) ctx.inject(['mcpResources'], inner => { inner.mcpResources.register(config.serverName, { async request(request, exec) {
    const current = generation;
    if (!live(current)) throw Error(`MCP server ${config.serverName} is disconnected`);
    const options = { signal: exec.signal, timeout };
    if (request.method === 'resources/list') return current.client.getServerCapabilities()?.resources === undefined ? { resources: [] } : current.client.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options);
    if (request.method === 'resources/templates/list') return current.client.getServerCapabilities()?.resources === undefined ? { resourceTemplates: [] } : current.client.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options);
    if (request.method === 'resources/read') return current.client.readResource({ uri: request.uri }, options);
    throw Error('Unsupported MCP resource operation');
  } });
    for (const name of MCP_RESOURCE_TOOL_NAMES) {
      if ((allowedTools !== null && !allowedTools.includes(name)) || deniedTools.includes(name)) continue;
      const definition = inner.tools.get(name, owner);
      if (definition) entry.resourceDefinitions.set(name, definition);
    }
  });
  ctx.inject(['systemPrompt'], inner => { inner.systemPrompt.section({ name: `mcp:${config.serverName}`, order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false, text: () => instructions }); });
  attempt = connect(true);
  try { await attempt; } catch (error) { await dispose(); throw error; }
}
