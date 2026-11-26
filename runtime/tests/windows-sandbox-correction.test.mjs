import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { answerTitleRequest } from './fixtures/title-request.mjs';

test('the model receives a stalled-shell timeout and can use a file tool in the same turn without restart', {
  skip: process.platform !== 'win32', timeout: 25000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-correction-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'fallback.txt'), 'FALLBACK_FILE_READ_SUCCEEDED');
  const bodies = [];
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (answerTitleRequest(body, res)) return;
    if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture' } }] })); return; }
    bodies.push(body);
    const results = body.messages.filter(message => message.role === 'tool');
    const call = (id, name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    let delta, finish;
    if (!results.length) delta = call('load-tools', 'search_mcp_tools', { names: ['pwsh', 'read'] });
    else if (!results.some(message => message.tool_call_id === 'stalled-shell')) delta = call('stalled-shell', 'pwsh', {
      command: "Set-Content -LiteralPath 'must-not-run.txt' -Value 'unexpected'", description: 'Bounded stalled preparation', timeoutMs: 1000,
    });
    else if (!results.some(message => message.tool_call_id === 'fallback-read')) delta = call('fallback-read', 'read', { file_path: 'fallback.txt' });
    else { delta = { role: 'assistant', content: 'Continued using the file tool after the shell failure.' }; finish = 'stop'; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'correction', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish ?? 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: project });
  let holder;
  t.after(async () => {
    if (holder?.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit'); holder.stdin.end('\n'); await exited;
    }
    await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const { sessionId } = await driver.createSession({ cwd: project, model: 'fixture', provider: {
    id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only',
  } });
  const lockRoot = join(tmpdir(), 'dsh-acl-locks'); await mkdir(lockRoot, { recursive: true });
  const lockPath = join(lockRoot, createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 16) + '.lock');
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:CB_LOCK,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite); $f.Lock(0,1); [Console]::WriteLine('LOCKED'); [void][Console]::ReadLine(); $f.Unlock(0,1); $f.Dispose()"],
  { windowsHide: true, env: { ...process.env, CB_LOCK: lockPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const [ready] = await once(holder.stdout, 'data'); assert.match(ready.toString(), /LOCKED/);
  await driver.prompt(sessionId, 'Run the diagnostic command. If it fails, read fallback.txt and explain the result.', { onPermission: () => true });
  const last = bodies.at(-1).messages;
  assert.match(JSON.stringify(last.find(message => message.tool_call_id === 'stalled-shell')), /timed out after 1000ms/);
  assert.match(JSON.stringify(last.find(message => message.tool_call_id === 'stalled-shell')), /preparation.*user command was not started/i);
  assert.match(JSON.stringify(last.find(message => message.tool_call_id === 'fallback-read')), /FALLBACK_FILE_READ_SUCCEEDED/);
  await assert.rejects(access(join(project, 'must-not-run.txt')));
  const history = await driver.history(sessionId);
  assert.equal(history.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
});
