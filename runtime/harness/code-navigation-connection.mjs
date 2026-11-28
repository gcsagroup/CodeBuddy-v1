import { join } from 'node:path';
import { createScope } from '@deepseek-ai/dsh-scope';
import { privateNavigation } from './mcp-bridge.mjs';
import { abortable } from './abortable.mjs';

// No parent-scope binding: neither the raw tools nor server instructions are
// projected into the agent. Its existing host facade remains the only caller.
export function createCodeNavigationConnection(agent, config) {
  const key = {}, scope = createScope(agent.ctx, key);
  let opening, closing, handle, retired = false;
  const open = () => opening ??= (async () => {
    if (retired) throw Error('Code navigation connection was retired');
    const connection = scope.ctx.plugin(privateNavigation, {
      serverName: 'codebuddy_navigation', transport: 'stdio', cwd: config.workspace,
      command: join(config.runtime, 'py/dependencies/python/python.exe'),
      args: ['-I', '-B', join(config.runtime, 'assets/code-navigation.py'), '--serve',
        '--workspace', config.workspace, '--state', config.state, '--node', process.execPath],
      env: {}, selectedTools: [], allowedTools: [], deniedTools: [],
      backgroundStart: true, failOnStartupError: true, toolCallTimeoutMs: 180000,
      reconnect: { enabled: false },
      onConnection(value) { handle = value; },
    });
    await connection;
    if (connection.state !== 2 || retired || !handle) throw Error('Code navigation connection is unavailable');
    return handle;
  })();
  const close = () => {
    retired = true;
    return closing ??= (async () => {
      try {
        await opening?.catch(() => {});
        if (handle) await handle.close();
      } finally { await scope.dispose(); }
    })();
  };
  agent.ctx.effect(() => close, 'CodeBuddy private navigation connection');
  return {
    get retired() { return retired || handle?.retired === true; },
    async request(operation, args, signal) {
      signal.throwIfAborted();
      let connection;
      try { connection = await abortable(open(), signal); }
      catch (error) {
        if (!handle?.ready || handle.retired) await close();
        throw error;
      }
      try { return await connection.request(operation, args, signal); }
      catch (error) {
        // A caller canceled while queued has not touched the MCP server. Only
        // the bridge can decide that an in-flight generation must be retired.
        if (connection.retired) await close();
        throw error;
      }
    },
    close,
  };
}
