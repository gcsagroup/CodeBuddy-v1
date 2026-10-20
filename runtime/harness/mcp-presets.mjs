import { createHash, randomUUID } from 'node:crypto';
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry';
import { compositionStatus } from './mcp-composition.mjs';
import { extensionConfigKey } from '../session-extensions.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function restrictSessionTools(ctx, filter, sharedKey) {
  if (!sharedKey || filter.allow === undefined) return ctx.tools.restrict(filter);
  let previous, signature;
  const refresh = () => {
    const inherited = ctx.tools.schemas(sharedKey).filter(tool => ctx.tools.get(tool.name, sharedKey) !== ctx.tools.get(tool.name)).map(tool => tool.name);
    const next = JSON.stringify(inherited);
    if (next === signature) return;
    // Set before changing the mask: the official registry emits tools/change
    // synchronously for restrictions too. New MCP generations remain visible.
    signature = next;
    const release = ctx.tools.restrict({ ...filter, allow: [...filter.allow, ...inherited] });
    const old = previous; previous = release; old?.();
  };
  refresh();
  ctx.on('tools/change', refresh, { global: true });
}

export async function createMcpPresets(ctx) {
  // Keep the registry private: its volatile connector definitions are not
  // user Agent presets and must not change durable session preset identities.
  const fiber = ctx.isolate('agentPresets').plugin(AgentPresetRegistry, { default: 'unused' });
  await fiber;
  if (fiber.state !== 2) throw Error('Harness MCP preset registry did not activate');
  const registry = fiber.ctx.agentPresets;
  const definitions = new Map();
  const retire = async (key, entry) => {
    if (definitions.get(key) === entry) definitions.delete(key);
    entry.retirement ??= entry.ready.then(value => value.unregister());
    await entry.retirement;
  };
  const trim = async () => {
    while (definitions.size > 8) {
      // Do not retire a declaration while another caller is acquiring its
      // official lease. This counter tracks pending acquisitions, not users.
      const oldest = [...definitions].find(([, entry]) => entry.acquiring === 0);
      if (!oldest) break;
      await retire(...oldest);
    }
  };
  return {
    async invalidate(configKeys) {
      const keys = new Set(configKeys.map(extensionConfigKey));
      await Promise.all([...definitions].filter(([, entry]) => entry.servers.some(server => keys.has(extensionConfigKey(server.serverName)))).map(([key, entry]) => retire(key, entry)));
    },
    async acquire(servers) {
      if (!servers.length) return;
      const key = createHash('sha256').update(JSON.stringify(canonical(servers))).digest('hex');
      let entry = definitions.get(key);
      const reused = Boolean(entry);
      if (!entry) {
        entry = { servers: structuredClone(servers), acquiring: 0, ready: (async () => {
          const id = `codebuddy-mcp-${randomUUID()}`;
          const unregister = await registry.register({ id, plugins: [{
            id: 'connections', name: new URL('./mcp-composition.mjs', import.meta.url).href,
            config: { servers: structuredClone(servers) },
          }] });
          return { id, unregister };
        })() };
        definitions.set(key, entry);
      } else {
        definitions.delete(key); definitions.set(key, entry);
      }
      entry.acquiring++;
      let lease;
      try {
        lease = await registry.acquireScope((await entry.ready).id);
        const statuses = compositionStatus(lease.key);
        // A failed initial connection is retried by a later acquisition. Live
        // leases retain healthy peers in this retired revision until release.
        if (statuses.some(status => status.status !== 'ready')) await retire(key, entry);
        return { ...lease, statuses, reused };
      } catch (error) {
        await lease?.[Symbol.asyncDispose]();
        await retire(key, entry).catch(() => {});
        throw error;
      } finally {
        entry.acquiring--;
        // Retired revisions still leased by sessions are collected by Harness.
        await trim();
      }
    },
  };
}
