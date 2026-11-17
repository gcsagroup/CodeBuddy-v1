import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTool, BROWSER_METHOD } from '../browser-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('website acceptance waits for an explicit choice before creating a preview', async () => {
  for (const decision of ['yes', 'no', 'skip', 'cancel']) {
    const calls = [], submitted = Promise.withResolvers();
    const controller = new AbortController();
    const tool = browserTool({ sessionId: 'website', cwd: '/site', request: async (method, params) => {
      calls.push({ method, params });
      return method === 'elicitation/create' ? submitted.promise : { id: 'test-tab', url: 'http://localhost/site' };
    } });
    const pending = tool.execute({ operation: 'offer_acceptance', path: 'index.html' }, { signal: controller.signal });
    assert.deepEqual(calls.map(c => c.method), ['elicitation/create']);
    const form = calls[0].params;
    assert.equal(form.sessionId, 'website');
    assert.equal(form._meta['codebuddy/question-blocking'], true);
    const choices = form._meta['codepro.dev/questionFields'].answer_0['codepro.dev/suggestedOptions'];
    if (decision === 'cancel') controller.abort();
    submitted.resolve(decision === 'skip' ? { action: 'decline' } :
      { action: 'accept', content: { answer_0: choices[decision === 'no' ? 1 : 0].const, feedback_0: 'Check mobile layout' } });
    if (decision === 'cancel') await assert.rejects(pending, /abort/i);
    else if (decision === 'yes') {
      assert.deepEqual(await pending, { id: 'test-tab', url: 'http://localhost/site', feedback: 'Check mobile layout' });
      assert.equal(calls[1].method, BROWSER_METHOD);
      assert.equal(calls[1].params.reuseAutomationTab, true);
      assert.equal(calls[1].params.operation, 'open');
    } else {
      const handoff = await pending;
      assert.equal(handoff.opened, false);
      assert.equal(handoff.path, 'index.html');
    }
    assert.equal(calls.length, decision === 'yes' ? 2 : 1);
  }
});
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

test('admitted host and stdio tools survive inherited masks, role changes and cold restart without ignoring denials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-tool-visibility-'));
  const script = path.join(root, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'ping',description:'Synthetic read',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'pong'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  let driver, current = { id: 'inherited-role', revision: 1, name: 'Inherited role', prompt: 'Use the current task.', capabilities: 'inherit', skills: [], tools: [], mcpServers: [] };
  t.after(async () => {
    await driver?.close();
    assert.equal(await realpath(path.dirname(root)), await realpath(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const provider = { id: 'offline', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' };
  const options = {
    toolFilter: { allow: ['read'] },
    mainAgentRole: { baseline: () => current, input: () => current },
    tools: [browserTool({ sessionId: 'host-session', cwd: root, request: () => ({ id: 'tab', url: 'http://127.0.0.1/fixture' }) })],
    mcpServers: [{ serverName: 'fixture', transport: 'stdio', command: process.execPath, args: [script], cwd: root }],
  };
  const names = async id => (await driver.listTools(id)).map(tool => tool.name);
  const browserCall = id => driver.callTool(id, 'browser_control', { operation: 'open', path: 'index.html' }, { onPermission: () => true });
  driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd: root });
  const { sessionId } = await driver.createSession({ cwd: root, provider, model: 'fixture', options });
  for (const name of ['browser_control', 'mcp__fixture__ping']) assert.ok((await names(sessionId)).includes(name), name);
  assert.equal((await browserCall(sessionId)).isError, false);
  assert.equal((await driver.callTool(sessionId, 'mcp__fixture__ping', {}, { onPermission: () => true })).isError, false);

  await driver.configureSession(sessionId, { toolFilter: { allow: ['read'], deny: ['browser_control'] } });
  assert.ok(!(await names(sessionId)).includes('browser_control'));
  assert.equal((await browserCall(sessionId)).isError, true, 'An explicit denial still blocks execution');

  current = { ...current, capabilities: 'selected', tools: ['read'] };
  await driver.configureSession(sessionId, options);
  for (const name of ['browser_control', 'mcp__fixture__ping']) assert.ok(!(await names(sessionId)).includes(name), name);
  current = null;
  await driver.configureSession(sessionId, options);
  for (const name of ['browser_control', 'mcp__fixture__ping']) assert.ok((await names(sessionId)).includes(name), name);

  await driver.close();
  driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd: root });
  await driver.createSession({ sessionId, cwd: root, provider, model: 'fixture', options });
  for (const name of ['browser_control', 'mcp__fixture__ping']) assert.ok((await names(sessionId)).includes(name), name);
  assert.equal((await browserCall(sessionId)).isError, false);
  await driver.configureSession(sessionId, { mcpServers: [] });
  assert.ok(!(await names(sessionId)).includes('mcp__fixture__ping'), 'Removed connections must disappear');
  await driver.configureSession(sessionId, { tools: [] });
  assert.ok(!(await names(sessionId)).includes('browser_control'), 'Removed host tools must disappear');
});
