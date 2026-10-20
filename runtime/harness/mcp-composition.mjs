import { scopeOf } from '@deepseek-ai/dsh-scope';
import * as mcpPlugin from './mcp-bridge.mjs';

const states = new WeakMap();
export const name = 'codebuddy-remote-mcp-composition';
export const inject = ['tools'];

// The official preset registry owns this standing scope, its references and
// disposal. Keep partial extension failures visible without disabling peers.
export async function apply(ctx, { servers }) {
  const key = scopeOf(ctx);
  const statuses = await Promise.all(servers.map(async server => {
    const started = performance.now();
    const connection = ctx.plugin(mcpPlugin, { ...server, failOnStartupError: true });
    try {
      await connection;
      if (connection.state !== 2) throw Error('MCP plugin did not activate');
      return { serverName: server.serverName, status: 'ready' };
    } catch {
      await connection.dispose();
      return { serverName: server.serverName, status: 'error', error: 'MCP connection or tool discovery failed. Reconfigure or retry this extension.' };
    } finally {
      console.info('[Harness shared MCP preparation]', JSON.stringify({ serverName: server.serverName, elapsedMs: Math.round(performance.now() - started) }));
    }
  }));
  states.set(key, statuses);
  ctx.effect(() => () => states.delete(key), 'codebuddy-mcp.status');
}

export const compositionStatus = key => (states.get(key) ?? []).map(status => {
  const live = mcpPlugin.mcpConnectionStatus(key, status.serverName);
  return live ? { serverName: status.serverName, status: live, ...(live === 'error' ? { error: 'MCP connection is unavailable or reconnecting.' } : {}) } : structuredClone(status);
});
