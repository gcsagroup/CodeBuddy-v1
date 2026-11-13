import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
const { Session } = await import('../harness/node_modules/@deepseek-ai/dsh-session/lib/index.js');

test('real native process recovery removes stale context on HTTP and cold restore without replaying tools', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-context-integration-'));
  await writeFile(join(root, 'notes.txt'), 'Isolated fixture, no user data.');
  const command = process.platform === 'win32'
    ? "if (Test-Path -LiteralPath './repaired.flag') { Write-Output 'RECOVERED'; exit 0 } else { Write-Output 'EXPECTED_FAILURE'; exit 3 }"
    : "if test -f ./repaired.flag; then echo RECOVERED; exit 0; else echo EXPECTED_FAILURE; exit 3; fi";
  const requests = [], events = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    const step = requests.length;
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'context-fixture',
      object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (step < 24) {
      let name = 'read', args = { file_path: 'notes.txt' };
      if (step === 0 || step === 3) { name = process.platform === 'win32' ? 'pwsh' : 'bash'; args = { command, description: 'Check isolated marker' }; }
      if (step === 2) { name = 'write'; args = { file_path: 'repaired.flag', content: 'ready' }; }
      emit({ tool_calls: [{ index: 0, id: 'fixture-call-' + step, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Completed the isolated context check.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver;
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const dataDir = join(root, 'state');
  driver = await createHarnessDriver({ dataDir, cwd: root });
  const settings = { cwd: root, provider: { id: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 262144, maxTokens: 2048, contextSource: 'configured' }, model: 'fixture' };
  const session = await driver.createSession(settings);
  const result = await driver.prompt(session.sessionId, 'Run only the isolated fixture checks.',
    { onPermission: () => true, onEvent: event => events.push(event) });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(requests.length, 25);
  const hasReminder = body => JSON.stringify(body.messages).includes('Unresolved process receipts (data):');
  assert.ok(requests.slice(1, 4).every(hasReminder), 'failure is still explicit through unrelated read and marker repair');
  assert.ok(requests.slice(4).every(body => !hasReminder(body)), 'the matching successful native rerun removes all stale reminders from wire history');
  assert.equal(await readFile(join(root, 'repaired.flag'), 'utf8'), 'ready');
  const history = await driver.history(session.sessionId);
  const calls = history.events.filter(event => event.type === 'tool/call');
  assert.equal(calls.length, 24);
  assert.equal(calls.filter(event => ['pwsh', 'bash'].includes(event.data.name)).length, 2);
  assert.equal(calls.filter(event => event.data.name === 'write').length, 1);
  const native = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  assert.equal(native.deriveMessages().filter(message => message.source?.kind === 'runtime-context').length, 1);
  assert.ok(history.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context').length > 1,
    'audit records remain intact while model visibility coalesces');
  const before = await driver.contextUsage(session.sessionId);
  await driver.close();
  driver = await createHarnessDriver({ dataDir, cwd: root });
  const after = await driver.contextUsage(session.sessionId);
  assert.equal(after.used, before.used, 'cold replay prices the same canonical surface');
  assert.equal(requests.length, 25, 'history recovery generates no model request');
  await driver.createSession({ ...settings, sessionId: session.sessionId });
  await driver.prompt(session.sessionId, 'Continue with a short answer and no tools.', { onPermission: () => true });
  const resumed = await driver.history(session.sessionId);
  assert.equal(resumed.events.filter(event => event.type === 'tool/call').length, calls.length);
  assert.ok(!hasReminder(requests.at(-1)));
  t.diagnostic(JSON.stringify({ requests: requests.length, tools: calls.length,
    processRuns: 2, writes: 1, visibleRuntimeSnapshots: 1, restoredUsedTokens: after.used,
    staleReminderAfterSuccess: false, modelRequestsOnRestore: 0, toolReplaysOnContinuation: 0 }));
});
