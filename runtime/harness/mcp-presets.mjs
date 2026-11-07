import { createHash, randomUUID } from 'node:crypto';
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry';
import { createScope } from '@deepseek-ai/dsh-scope';
import { connectionStatus } from './mcp-connection.mjs';
import { projectMcpConnection, waitForMcpServers } from './mcp-bridge.mjs';
import { extensionConfigKey } from '../session-extensions.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function restrictSessionTools(ctx, filter, inheritedScope, inheritedFilter) {
  if (!inheritedScope || filter.allow === undefined) return ctx.tools.restrict(filter);
  let previous, signature;
  const refresh = () => {
    const inherited = ctx.tools.schemas(inheritedScope).filter(tool =>
      ctx.tools.get(tool.name, inheritedScope) !== ctx.tools.get(tool.name) &&
      (!inheritedFilter?.allow || inheritedFilter.allow.includes(tool.name)) &&
      !inheritedFilter?.deny?.includes(tool.name)
    ).map(tool => tool.name);
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
    while (definitions.size > 64) {
      // Do not retire a declaration while another caller is acquiring its
      // official lease. This counter tracks pending acquisitions, not users.
      const oldest = [...definitions].find(([, entry]) => entry.acquiring === 0);
      if (!oldest) break;
      await retire(...oldest);
    }
  };
  async function acquireConnection(server) {
      const { backgroundStart: _backgroundStart, ...identity } = server;
      const key = createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
      let entry = definitions.get(key);
      const reused = Boolean(entry);
      if (!entry) {
        entry = { server: structuredClone(server), acquiring: 0, ready: (async () => {
          const id = `codebuddy-mcp-${randomUUID()}`;
          const unregister = await registry.register({ id, plugins: [{
            id: 'connection', name: new URL('./mcp-connection.mjs', import.meta.url).href,
            config: { ...structuredClone(server), backgroundStart: true },
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
        if (!server.backgroundStart) await waitForMcpServers(lease.key, [server.serverName]);
        const statuses = [connectionStatus(lease.key)];
        // Retire only this failed connection; healthy peers retain their leases.
        if (statuses.some(status => status.status === 'error')) await retire(key, entry);
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
  }
  return {
    async invalidate(configKeys) {
      const keys = new Set(configKeys.map(extensionConfigKey));
      await Promise.all([...definitions].filter(([, entry]) => keys.has(extensionConfigKey(entry.server.serverName))).map(([key, entry]) => retire(key, entry)));
    },
    async acquire(servers) {
      if (!servers.length) return;
      const results = await Promise.allSettled(servers.map(acquireConnection));
      const leases = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) {
        await Promise.all(leases.map(lease => lease[Symbol.asyncDispose]()));
        throw failure.reason;
      }
      const key = {}, scope = createScope(ctx, key);
      let disposing;
      const dispose = () => disposing ??= (async () => {
        try { await scope.dispose(); }
        finally { await Promise.all(leases.map(lease => lease[Symbol.asyncDispose]())); }
      })();
      try {
        const view = scope.ctx.plugin({
          name: 'codebuddy-mcp-selection', inject: ['tools'],
          apply(inner) { for (const [index, server] of servers.entries()) projectMcpConnection(inner, leases[index].key, server.serverName); },
        });
        await view;
        if (view.state !== 2) throw Error('MCP selection did not activate');
        return { key, statuses: leases.flatMap(lease => lease.statuses), reused: leases.every(lease => lease.reused), [Symbol.asyncDispose]: dispose };
      } catch (error) { await dispose(); throw error; }
    },
  };
}
