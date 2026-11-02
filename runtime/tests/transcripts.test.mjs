import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rename, mkdir, rmdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openStore } from '../store.mjs';
import { openTranscriptJournal } from '../transcripts.mjs';

const user = (text) => ({ sessionUpdate: 'user_message_chunk', messageId: 'user-fixture', content: { type: 'text', text } });
const reply = (text) => ({ sessionUpdate: 'agent_message_chunk', messageId: 'assistant-fixture', content: { type: 'text', text } });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-transcript-'));
  const store = await openStore(directory);
  await store.update((state) => { state.sessions.push({ id: 'session-fixture', title: 'New Session', messageCount: 0, updates: [], usageUpdates: [] }); });
  return { directory, store };
}

test('ordered journal chunks commit once with usage and title in the runtime store', async () => {
  const { store } = await fixture();
  const journal = await openTranscriptJournal(store);
  const writer = await journal.begin({ sessionId: 'session-fixture', turnId: 'turn-1', users: [user('Build modules')], title: 'Build modules' });
  await Promise.all([writer.append(reply('one')), writer.append(reply('two')), writer.appendUsage({ sessionUpdate: 'usage_update', usage: { totalTokens: 12 } })]);
  const path = join(journal.directory, (await readdir(journal.directory))[0]);
  assert.equal((await readFile(path, 'utf8')).trimEnd().split('\n').length, 4);
  await writer.finalize();
  await writer.finalize();
  const session = store.read().sessions[0];
  assert.deepEqual(session.updates.map((chunk) => chunk.content.text), ['Build modules', 'one', 'two']);
  assert.equal(session.usageUpdates.length, 1);
  assert.equal(session.messageCount, 2);
  assert.equal(session.title, 'Build modules');
  assert.deepEqual(await readdir(journal.directory), []);
  await assert.rejects(journal.begin({ sessionId: 'session-fixture', turnId: 'turn-1' }), /already finalized/);
});

test('a killed separate process recovers fsynced partial conversation without a turn completion', { timeout: 15000 }, async () => {
  const { directory } = await fixture();
  const source = `
    import { openStore } from ${JSON.stringify(new URL('../store.mjs', import.meta.url).href)};
    import { openTranscriptJournal } from ${JSON.stringify(new URL('../transcripts.mjs', import.meta.url).href)};
    const store = await openStore(process.argv[1]);
    const journal = await openTranscriptJournal(store);
    const writer = await journal.begin({sessionId:'session-fixture',turnId:'killed-turn',users:[${JSON.stringify(user('Continue long task'))}]});
    await writer.append(${JSON.stringify(reply('verified partial result'))});
    process.stdout.write('DURABLE_READY');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes('DURABLE_READY')) resolve(); });
      child.once('exit', (code) => reject(new Error(`Fixture exited before kill: ${code} ${stderr}`)));
      child.once('error', reject);
    });
    await ready;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const fresh = await openStore(directory);
    assert.equal(fresh.read().sessions[0].updates.length, 0);
    const recovered = await openTranscriptJournal(fresh);
    assert.equal(recovered.recovered.length, 1);
    assert.deepEqual(fresh.read().sessions[0].updates.map((chunk) => chunk.content.text), ['Continue long task', 'verified partial result']);
    assert.equal(fresh.read().sessions[0].messageCount, 2);
    assert.equal(fresh.read().sessions[0].usageUpdates.length, 0, 'recovery does not invent terminal or completion evidence');
    await openTranscriptJournal(await openStore(directory));
    assert.equal((await openStore(directory)).read().sessions[0].updates.length, 2);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('a torn final NDJSON record is ignored while all earlier committed records recover', async () => {
  const { store, directory } = await fixture();
  const journal = await openTranscriptJournal(store);
  const writer = await journal.begin({ sessionId: 'session-fixture', turnId: 'torn-turn', users: [user('retain')] });
  await writer.append(reply('durable'));
  const file = join(journal.directory, (await readdir(journal.directory))[0]);
  const complete = await readFile(file, 'utf8');
  await writer.finalize();
  // Recreate a pre-finalize state and a journal ending during the next append.
  await store.update((state) => { state.sessions[0].updates = []; state.sessions[0].messageCount = 0; delete state.sessions[0].transcriptTurns; });
  await writeFile(file, complete);
  await appendFile(file, '{"version":1,"kind":"update","update":{"content":"torn');
  const fresh = await openStore(directory);
  await openTranscriptJournal(fresh);
  assert.deepEqual(fresh.read().sessions[0].updates.map((chunk) => chunk.content.text), ['retain', 'durable']);
});

test('state committed before unlink failure replays the journal without duplicate chunks', async () => {
  const { store, directory } = await fixture();
  let journalFile, displaced, breakCleanup = false;
  const failing = { ...store, async updateSession(id, fn, options) {
    const result = await store.updateSession(id, fn, options);
    if (breakCleanup) {
      breakCleanup = false;
      displaced = journalFile + '.preserved';
      await rename(journalFile, displaced);
      await mkdir(journalFile);
    }
    return result;
  } };
  const journal = await openTranscriptJournal(failing);
  const writer = await journal.begin({ sessionId: 'session-fixture', turnId: 'cleanup-turn', users: [user('once')] });
  await writer.append(reply('also once'));
  journalFile = join(journal.directory, (await readdir(journal.directory))[0]);
  breakCleanup = true;
  await assert.rejects(writer.finalize(), (error) => ['EISDIR', 'EPERM', 'EACCES'].includes(error.code));
  assert.equal(store.read().sessions[0].updates.length, 2);
  await rmdir(journalFile);
  await rename(displaced, journalFile);
  const fresh = await openStore(directory);
  const recovered = await openTranscriptJournal(fresh);
  assert.equal(recovered.recovered[0].duplicate, true);
  assert.equal(fresh.read().sessions[0].updates.length, 2);
  assert.equal(fresh.read().sessions[0].messageCount, 2);
  assert.deepEqual(await readdir(journal.directory), []);
});
