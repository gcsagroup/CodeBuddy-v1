import test from 'node:test';
import assert from 'node:assert/strict';
import { commandEvidence, recordCommandOutcome, commandReminder, COMMAND_REMINDER_MAX_CHARS } from '../harness/command-evidence.mjs';
const receipt = (id, command = 'verify', exit = 1, cwd = 'D:/fixture') => commandEvidence(
  { callId: id, name: 'pwsh', arguments: { command } },
  { value: { kind: 'foreground', cwd, exitCode: exit, stdout: { text: 'private output' } } });

test('only the exact successful native rerun resolves a failure; unrelated receipts cannot change the reminder', () => {
  const pending = new Map();
  recordCommandOutcome(pending, receipt('a', 'verify A'));
  recordCommandOutcome(pending, receipt('b', 'verify B'));
  const before = commandReminder(pending);
  for (let n = 0; n < 225; n++) {
    recordCommandOutcome(pending, { id: String(n), tool: 'read', kind: 'tool', output: 'read content' });
    recordCommandOutcome(pending, receipt(String(n), 'unrelated', 0));
  }
  assert.equal(commandReminder(pending), before);
  recordCommandOutcome(pending, receipt('other-directory', 'verify A', 0, 'D:/elsewhere'));
  assert.equal(pending.size, 2);
  recordCommandOutcome(pending, receipt('rerun', 'verify A', 0));
  assert.equal(pending.size, 1);
  assert.doesNotMatch(commandReminder(pending), /verify A/);
  assert.match(commandReminder(pending), /verify B/);
  recordCommandOutcome(pending, receipt('last', 'verify B', 0));
  assert.equal(commandReminder(pending), '');
});

test('large commands, writes and many failures have a bounded reminder without losing unresolved items', () => {
  const pending = new Map(), full = 'x'.repeat(100_000);
  for (let n = 0; n < 100; n++) recordCommandOutcome(pending, receipt(String(n), full + n));
  recordCommandOutcome(pending, { id: 'write', tool: 'write', path: 'private.txt', content: full });
  const reminder = commandReminder(pending);
  assert.ok(reminder.length <= COMMAND_REMINDER_MAX_CHARS);
  assert.doesNotMatch(reminder, /private output|private.txt/);
  assert.ok(!reminder.includes(full));
  const details = JSON.parse(reminder.slice(reminder.indexOf('{')));
  assert.equal(details.total, 100);
  assert.equal(details.receipts.length + details.remaining, 100);
  assert.equal(pending.size, 100);
  assert.ok(details.receipts.every(fact => fact.command.length <= 256));
  recordCommandOutcome(pending, receipt('resolved-hidden-item', full + 99, 0));
  assert.equal(pending.size, 99);
});

test('interactive reminders point to exact unresolved process results without repeating shell source', () => {
  const pending = new Map(), compact = () => commandReminder(pending, { referencesOnly: true });
  recordCommandOutcome(pending, receipt('failed-check', 'private failing command', 7));
  recordCommandOutcome(pending, receipt('other-check', 'another private command', 2));
  recordCommandOutcome(pending, receipt('other-directory', 'private failing command', 0, '/elsewhere'));
  assert.doesNotMatch(compact(), /private|D:\/fixture/);
  const entries = () => JSON.parse(compact().slice(compact().indexOf('{'))).receipts;
  assert.deepEqual(entries().map(f=>[f.id,f.exit]), [['failed-check',7],['other-check',2]]);
  recordCommandOutcome(pending, receipt('resolved', 'private failing command', 0));
  assert.deepEqual(entries().map(f=>f.id), ['other-check']);
  recordCommandOutcome(pending, receipt('resolved-too', 'another private command', 0));
  assert.equal(compact(), '');
});
