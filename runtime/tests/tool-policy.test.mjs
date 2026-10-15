import test from 'node:test';
import assert from 'node:assert/strict';
import { publicToolName, harnessToolName, toolEnabled } from '../tool-policy.mjs';

test('UI tool names round trip for native, memory, CodePro, Git and MCP', () => {
  for (const name of ['write', 'project_memory', 'codebuddy_task', 'git_repository_snapshot', 'github_runtime_status', 'mcp__qwen_computer__click', 'mcp__fixture__echo']) assert.equal(harnessToolName(publicToolName(name)), name);
  assert.equal(harnessToolName('git_repository_snapshot'), 'git_repository_snapshot');
});

test('global switches and allowlists own both native and builtin MCP dispatch', async () => {
  const entries = [
    { configKey: 'developer', enabled: true, extension: { type: 'builtin', name: 'developer', available_tools: ['read'] } },
    { configKey: 'git', enabled: true, extension: { type: 'builtin', name: 'git' } },
    { configKey: 'qwen_computer', enabled: true, extension: { type: 'builtin', name: 'qwen_computer', available_tools: ['screenshot'] } },
  ];
  const settings = { extensions: async () => entries };
  const session = { type: 'code_pro', extensions: ['developer', 'git', 'qwen_computer'], mcpServers: [{ name: 'qwen_computer' }] };
  assert.equal(await toolEnabled(session, settings, 'read'), true);
  assert.equal(await toolEnabled(session, settings, 'write'), false);
  assert.equal(await toolEnabled(session, settings, 'git_status'), true);
  assert.equal(await toolEnabled(session, settings, 'mcp__qwen_computer__screenshot'), true);
  assert.equal(await toolEnabled(session, settings, 'mcp__qwen_computer__click'), false);
  entries[2].enabled = false;
  assert.equal(await toolEnabled(session, settings, 'mcp__qwen_computer__screenshot'), false, 'raw session metadata must not reactivate a globally disabled server');
  assert.equal(await toolEnabled(session, settings, 'read_mcp_resource'), false, 'resource tools must not reactivate a globally disabled server');
  entries[0].enabled = false;
  assert.equal(await toolEnabled(session, settings, 'read'), false);
  assert.equal(await toolEnabled({ type: 'user', extensions: [] }, settings, 'codebuddy_task'), false);
});

test('unknown tools and disabled project memory do not inherit developer permission', async () => {
  const settings = { extensions: async () => [{ configKey: 'developer', enabled: true, extension: { name: 'developer', type: 'builtin' } }] };
  assert.equal(await toolEnabled({ extensions: ['developer'] }, settings, 'project_memory'), false);
  assert.equal(await toolEnabled({ extensions: ['developer'] }, settings, 'git_status'), false);
  assert.equal(await toolEnabled({ extensions: ['developer'] }, settings, 'mcp__other__read'), false);
});
