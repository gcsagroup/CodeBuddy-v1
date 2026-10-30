import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { CODEBUDDY_BEHAVIOR } from '../harness/profile.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

test('real Harness enforces role guard for scope-local tools and filters Skill loading per session', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-policy-harness-'));
  const skillDir = path.join(root, '.agents', 'skills', 'allowed-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: allowed-skill\ndescription: Isolated test skill\n---\nSKILL_CONTENT');
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
  let effects = 0;
  const create = async skills => {
    const sessionId = randomUUID();
    await driver.createSession({ sessionId, cwd: root, model: 'fixture', provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, options: {
      agentProfile: { skills, tools: ['skill'], mcpServers: [] }, toolFilter: { allow: ['skill'] },
      tools: [{ name: 'injected_tool', inputSchema: { type: 'object', properties: {} }, execute: async () => { effects++; return {}; } }],
    } }); return sessionId;
  };
  const allowed = await create(['allowed-skill']), denied = await create([]);
  assert.ok((await driver.listSkills(allowed)).some(s => s.name === 'allowed-skill'));
  assert.deepEqual(await driver.listSkills(denied), []);
  assert.equal((await driver.callTool(allowed, 'skill', { name: 'allowed-skill' })).isError, false);
  assert.equal((await driver.callTool(denied, 'skill', { name: 'allowed-skill' })).isError, true);
  const rejected = await driver.callTool(allowed, 'injected_tool', {}, { onPermission: async () => true });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected), /disabled by the workspace agent/);
  assert.equal(effects, 0);
});

test('actual parent and spawned child requests carry the same persona, model and restricted capability catalog', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-role-request-'));
  const requests = [];
  let mainStep = 0;
  const childSeen = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const child = body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_ROLE_PROBE'));
    let call;
    if (!child && mainStep++ === 0) call = { name: 'search_mcp_tools', arguments: JSON.stringify({ names: ['subagent'] }) };
    else if (!child && mainStep === 2) call = { name: 'subagent', arguments: JSON.stringify({ description: 'Role inheritance probe', prompt: 'CHILD_ROLE_PROBE: reply briefly.' }) };
    if (child) childSeen.resolve(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (call) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: call }] }); emit({}, 'tool_calls'); }
    else { emit({ role: 'assistant', content: 'ROLE_RESPONSE' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const sessionId = randomUUID();
  const tools = ['search_mcp_tools', 'subagent'];
  await driver.createSession({ sessionId, cwd: root, model: 'pinned-role-model', provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, options: {
    systemPrompt: 'ROLE_PERSONA_SENTINEL: You are a careful research partner.',
    agentProfile: { skills: [], tools, mcpServers: [] }, toolFilter: { allow: ['subagent'] },
  } });
  await driver.prompt(sessionId, [{ type: 'text', text: 'Delegate a short probe.' }], { onPermission: async () => true });
  await childSeen.promise;
  for (const body of requests) {
    assert.equal(body.model, 'pinned-role-model');
    assert.match(JSON.stringify(body.messages), /ROLE_PERSONA_SENTINEL/);
    assert.ok(!JSON.stringify(body.messages).includes('You are CodeBuddy, an AI software engineering assistant'));
    assert.ok(JSON.stringify(body.messages).includes(CODEBUDDY_BEHAVIOR));
    assert.ok(!body.tools?.some(tool => ['write', 'pwsh', 'bash', 'skill'].includes(tool.function.name)));
  }
  assert.ok(requests.length >= 3);
  const ordinary = randomUUID();
  await driver.createSession({ sessionId: ordinary, cwd: root, model: 'ordinary-model', provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture' }, options: {} });
  await driver.prompt(ordinary, [{ type: 'text', text: 'Reply briefly.' }], { onPermission: async () => true });
  const normal = JSON.stringify(requests.at(-1).messages);
  assert.ok(normal.includes('You are CodeBuddy, an AI software engineering assistant'));
  assert.ok(normal.includes(CODEBUDDY_BEHAVIOR));
  assert.ok(!normal.includes('ROLE_PERSONA_SENTINEL'));
});
