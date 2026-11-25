import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { createCompatServer } from '../server.mjs';
import { answerTitleRequest } from './fixtures/title-request.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-control-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'fallback.txt'), 'FALLBACK_AFTER_PREPARATION');
  const toolStarted = Promise.withResolvers(), requests = [];
  const model = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    if (req.method !== 'POST') { res.writeHead(404).end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (answerTitleRequest(body, res)) return;
    if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture' } }] })); return; }
    requests.push(body);
    const results = body.messages.filter(message => message.role === 'tool');
    const call = (id, name, args) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    let delta, reason = 'tool_calls';
    if (!results.length) delta = call('load', 'search_mcp_tools', { names: ['pwsh', 'read'] });
    else if (!results.some(message => message.tool_call_id === 'stalled-shell')) delta = call('stalled-shell', 'pwsh', {
      command: "Set-Content -LiteralPath 'must-not-run.txt' -Value 'unexpected'", timeoutMs: 120000, description: 'Isolated blocked preparation',
    });
    else if (!results.some(message => message.tool_call_id === 'fallback')) delta = call('fallback', 'read', { file_path: 'fallback.txt' });
    else { delta = { content: 'Continued after preparation failure.' }; reason = 'stop'; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'control-fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: project });
  const secret = 'isolated-windows-sandbox-control';
  const backend = await createCompatServer({ dataDir: join(root, 'host'), secret, driver });
  const url = await backend.listen(0, '127.0.0.1');
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/acp?token=' + secret);
  await once(ws, 'open');
  const pending = new Map(); let sequence = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id); clearTimeout(waiter.timer);
      message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
    } else if (message.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
    else if (message.method === 'session/update' && message.params.update.sessionUpdate === 'tool_call' &&
      message.params.update.toolCallId === 'stalled-shell') toolStarted.resolve();
  });
  function rpc(method, params = {}, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('No response: ' + method)); }, timeout);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  let holder;
  t.after(async () => {
    if (holder?.exitCode === null && holder.signalCode === null) { const exited = once(holder, 'exit'); holder.stdin.end('\n'); await exited; }
    ws.close(); for (const waiter of pending.values()) clearTimeout(waiter.timer);
    await backend.close(); await driver.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } } });
  const { providerId } = await rpc('_goose/unstable/providers/custom/create', { engine: 'openai_compatible', displayName: 'Fixture',
    apiUrl: `http://127.0.0.1:${model.address().port}`, requiresAuth: false, models: ['fixture'], supportsStreaming: true, headers: {} });
  await rpc('_goose/unstable/defaults/save', { providerId, modelId: 'fixture' });
  const { sessionId } = await rpc('session/new', { cwd: project, mcpServers: [], _meta: { workspaceMode: 'code' } });
  const lockDir = join(tmpdir(), 'dsh-acl-locks'); await mkdir(lockDir, { recursive: true });
  const lock = join(lockDir, createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 16) + '.lock');
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:CB_LOCK,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);$f.Lock(0,1);[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null;$f.Unlock(0,1);$f.Dispose()"],
    { windowsHide: true, env: { ...process.env, CB_LOCK: lock }, stdio: ['pipe', 'pipe', 'ignore'] });
  await once(holder.stdout, 'data');
  return { project, sessionId, rpc, toolStarted, requests };
}

async function controlChecks(f) {
  await Promise.race([f.toolStarted.promise, delay(5000).then(() => { throw Error('Shell was not dispatched'); })]);
  await delay(700); // Let the real helper enter the native lock, beyond startup.
  const times = {};
  for (const [name, method, params] of [
    ['sessionExport', '_goose/unstable/session/export', { sessionId: f.sessionId }],
    ['logExport', '_goose/unstable/session/log/export', { sessionId: f.sessionId, detail: 'standard' }],
    ['newSession', 'session/new', { cwd: f.project, mcpServers: [], _meta: { workspaceMode: 'code' } }],
  ]) {
    const start = performance.now(); await f.rpc(method, params); times[name] = Math.round(performance.now() - start);
    assert.ok(times[name] < 1000, `${name} stalled behind native preparation: ${times[name]}ms`);
  }
  return times;
}

test('the real ACP control lane responds during the native 120s tool deadline and the same turn can recover', {
  skip: process.platform !== 'win32', timeout: 145000,
}, async t => {
  const f = await fixture(t), started = performance.now();
  const prompting = f.rpc('session/prompt', { sessionId: f.sessionId, prompt: [{ type: 'text', text: 'Run the isolated diagnostic, then read fallback.txt if preparation fails.' }] }, 135000);
  prompting.catch(() => {});
  const controls = await controlChecks(f);
  await prompting;
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(elapsedMs >= 119000 && elapsedMs < 125000, `The real default deadline took ${elapsedMs}ms`);
  const messages = f.requests.at(-1).messages;
  assert.match(JSON.stringify(messages.find(message => message.tool_call_id === 'stalled-shell')), /timed out after 120000ms|120000ms preparation deadline/);
  assert.match(JSON.stringify(messages.find(message => message.tool_call_id === 'fallback')), /FALLBACK_AFTER_PREPARATION/);
  await assert.rejects(access(join(f.project, 'must-not-run.txt')));
  t.diagnostic(JSON.stringify({ elapsedMs, controls }));
});

test('ACP cancellation returns while native preparation remains locked and never dispatches the stopped command', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const f = await fixture(t);
  const prompting = f.rpc('session/prompt', { sessionId: f.sessionId, prompt: [{ type: 'text', text: 'Run the isolated diagnostic.' }] }, 12000);
  prompting.catch(() => {});
  const controls = await controlChecks(f);
  const start = performance.now(); await f.rpc('session/cancel', { sessionId: f.sessionId }); await prompting;
  const elapsedMs = Math.round(performance.now() - start);
  assert.ok(elapsedMs < 1000, `Cancellation waited ${elapsedMs}ms for the native lock`);
  await delay(300); await assert.rejects(access(join(f.project, 'must-not-run.txt')));
  t.diagnostic(JSON.stringify({ cancellationMs: elapsedMs, controls }));
});
