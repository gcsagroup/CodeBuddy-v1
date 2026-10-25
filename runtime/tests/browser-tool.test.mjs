import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTool, BROWSER_METHOD } from '../browser-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('browser tool binds host session/workspace and validates before dispatch', async () => {
  const calls = [];
  const tool = browserTool({ sessionId: 'session-a', cwd: '/workspace', request: (...args) => { calls.push(args); return {id:'tab',url:'http://127.0.0.1:1234/index.html'}; } });
  await assert.rejects(tool.execute({operation:'open',url:'http://localhost',path:'index.html'}));
  await assert.rejects(tool.execute({operation:'click',node:1}));
  await assert.rejects(tool.execute({operation:'type',id:'tab',text:'search'}), /type requires.*node/);
  await assert.rejects(tool.execute({operation:'click',id:'tab',node:0}), /click requires.*node/);
  assert.equal(calls.length,0);
  await tool.execute({operation:'open',path:'index.html'});
  assert.equal(calls[0][0],BROWSER_METHOD);
  assert.deepEqual(calls[0][1].scope,{sessionId:'session-a',root:'/workspace'});
  assert.equal(calls[0][1].htmlPath,'index.html');
  await assert.rejects(tool.execute({operation:'observe',id:'tab'},{signal:AbortSignal.abort()}));
  assert.equal(calls.length,1);
  const failing = browserTool({ sessionId: 'a', cwd: '/workspace', request: async () => ({ error: { message: 'ENOENT: missing.html' } }) });
  await assert.rejects(failing.execute({ operation: 'open', path: 'missing.html' }), /Browser operation failed: ENOENT: missing.html/);
  const missingReceipt = browserTool({ sessionId: 'a', cwd: '/workspace', request: async () => ({}) });
  await assert.rejects(missingReceipt.execute({ operation: 'open', path: 'index.html' }), /did not return a loaded tab/);
});

test('scoped browser tool remains discoverable with a native tool filter and enforces approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-browser-registration-'));
  let driver;
  const calls = [];
  try {
    driver = await createHarnessDriver({ dataDir: root, cwd: root });
    const { sessionId } = await driver.createSession({ cwd: root,
      provider: { id: 'offline', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' }, model: 'fixture',
      options: { toolFilter: { allow: ['read'] }, tools: [browserTool({ sessionId: 'host-session', cwd: root,
        request: (method, params) => { calls.push({ method, params }); return { id: 'tab', url: 'http://127.0.0.1:1234/index.html' }; },
      })] },
    });
    const discovered = await driver.callTool(sessionId, 'search_mcp_tools', { names: ['browser_control'] }, { onPermission: () => true });
    assert.equal(discovered.isError, false);
    assert.match(JSON.stringify(discovered.content), /browser_control/);
    const denied = await driver.callTool(sessionId, 'browser_control', { operation: 'open', path: 'index.html' }, { onToolPolicy: () => ({ kind: 'ask' }), onPermission: () => false });
    assert.equal(denied.isError, true);
    assert.equal(calls.length, 0);
    const allowed = await driver.callTool(sessionId, 'browser_control', { operation: 'open', path: 'index.html' }, { onPermission: () => true });
    assert.equal(allowed.isError, false);
    assert.equal(calls[0].method, BROWSER_METHOD);
    assert.deepEqual(calls[0].params.scope, { sessionId: 'host-session', root });
  } finally {
    await driver?.close();
    await rm(root, { recursive: true, force: true });
  }
});
