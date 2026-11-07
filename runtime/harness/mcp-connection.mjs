import { scopeOf } from '@deepseek-ai/dsh-scope';
import * as mcpPlugin from './mcp-bridge.mjs';
import { mcpDiagnostic } from './mcp-diagnostics.mjs';

const states = new WeakMap();
export const name = 'codebuddy-remote-mcp-connection';
export const inject = ['tools'];

// One native preset lease owns one transport; failed peers cannot retire it.
export async function apply(ctx, server) {
  const key = scopeOf(ctx), started = performance.now();
  const connection = ctx.plugin(mcpPlugin, { ...server, failOnStartupError: true });
  let status;
  try {
    await connection;
    if (connection.state !== 2) throw Error('MCP plugin did not activate');
    status = { serverName: server.serverName, status: mcpPlugin.mcpConnectionStatus(key, server.serverName) };
  } catch (error) {
    await connection.dispose();
    status = { serverName: server.serverName, status: 'error', error: mcpDiagnostic(error, server) };
  } finally {
    console.info('[Harness shared MCP preparation]', JSON.stringify({ serverName: server.serverName, elapsedMs: Math.round(performance.now() - started) }));
  }
  states.set(key, status);
  ctx.effect(() => () => states.delete(key), 'codebuddy-mcp.status');
}

export function connectionStatus(key) {
  const status = states.get(key);
  if (!status) throw Error('MCP connection scope has no status');
  const live = mcpPlugin.mcpConnectionStatus(key, status.serverName);
  return live ? { serverName: status.serverName, status: live, ...(live === 'error' ? { error: mcpPlugin.mcpConnectionError(key, status.serverName) ?? 'MCP connection is unavailable or reconnecting.' } : {}) } : structuredClone(status);
}
