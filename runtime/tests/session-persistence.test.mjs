import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openStore } from '../store.mjs';
import { openTranscriptJournal } from '../transcripts.mjs';

const message = (role, text) => ({ sessionUpdate: `${role}_message_chunk`, content: { type: 'text', text } });
async function fixture(options) {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-session-persistence-'));
  const store = await openStore(directory, options);
  await store.update(state => {
    state.sessions = Array.from({ length: 8 }, (_, i) => ({ id: `chat-${i}`, title: 'New Session', messageCount: 0, updates: [], usageUpdates: [] }));
    state.providers = [{ id: 'unchanged-provider' }];
    state.preferences = { marker: 'preserve me' };
    state.legacyFixture = { rows: ['旧记录', null, '🙂\u0000\n"\\\ud800'] };
  });
  return { directory, store };
}
async function disk(store, directory) {
  const raw = await readFile(join(directory, 'state.json'), 'utf8');
  assert.equal(raw, JSON.stringify(store.read()) + '\n');
  return JSON.parse(raw);
}

test('session writes are detached, fail atomically and remain ordered with legacy full and root writes', async () => {
  let deny = false;
  const { store, directory } = await fixture({ replaceFile: (from, to) => {
    if (deny) throw Object.assign(Error('Disk full at commit fixture'), { code: 'ENOSPC' });
    return rename(from, to);
  } });
  const baseline = store.read();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let retained;
  const first = store.updateSession('chat-0', async session => {
    retained = session;
    session.updates.push({ content: { text: 'first' } });
    entered.resolve(); await release.promise;
    return session.updates;
  });
  await entered.promise;
  assert.deepEqual(store.readSession('chat-0').updates, []);
  const legacy = store.update(state => { state.sessions[1].title = 'legacy changed'; state.revision++; });
  const second = store.updateSession('chat-0', session => { session.updates.push({ content: { text: 'second' } }); });
  const root = store.update(state => { state.preferences.marker = 'new preference'; }, ['preferences']);
  release.resolve();
  const returned = await first;
  await Promise.all([legacy, second, root]);
  retained.updates[0].content.text = 'outside draft'; returned[0].content.text = 'outside return';
  assert.deepEqual(store.readSession('chat-0').updates.map(row => row.content.text), ['first', 'second']);
  const committed = await disk(store, directory);
  assert.equal(committed.sessions[1].title, 'legacy changed');
  assert.deepEqual(committed.sessions.slice(2), baseline.sessions.slice(2));
  assert.deepEqual(committed.providers, baseline.providers);
  assert.deepEqual(committed.legacyFixture, baseline.legacyFixture);
  deny = true;
  await assert.rejects(store.updateSession('chat-0', session => { session.updates.push('must not publish'); }), { code: 'ENOSPC' });
  deny = false;
  await assert.rejects(store.updateSession('chat-0', session => { session.updates.push(1n); }), TypeError);
  await assert.rejects(store.updateSession('chat-0', session => { session.id = 'renamed'; }), /identity/);
  await assert.rejects(store.updateSession('missing', () => {}), /missing/);
  await store.updateSession('chat-2', session => { session.title = 'after failures'; });
  assert.deepEqual((await openStore(directory)).readSession('chat-0'), committed.sessions[0]);
  await disk(store, directory);
});

test('legacy session replacement, reorder and deletion invalidate bytes without resurrecting old records', async () => {
  const { store, directory } = await fixture();
  await store.updateSession('chat-1', session => { session.updates.push({ content: { text: 'earlier' } }); });
  await store.update(state => {
    state.sessions = [state.sessions[2], { id: 'replacement', title: 'imported', updates: [{ text: 'import' }] }, state.sessions[1]];
  }, ['sessions']);
  await store.updateSession('chat-1', session => { session.updates.push({ text: 'later' }); });
  await assert.rejects(store.updateSession('chat-0', () => {}), /missing/);
  const saved = await disk(store, directory);
  assert.deepEqual(saved.sessions.map(session => session.id), ['chat-2', 'replacement', 'chat-1']);
  assert.equal(saved.sessions[2].updates[0].content.text, 'earlier');
  assert.equal(saved.sessions[2].updates[1].text, 'later');
  assert.equal((await openStore(directory)).readSession('replacement').updates[0].text, 'import');
});

test('failed transcript save leaves durable journal for exact-once recovery on a fresh store', async () => {
  let deny = false;
  const { store, directory } = await fixture({ replaceFile: (from, to) => {
    if (deny) throw Object.assign(Error('Persistent replace fixture'), { code: 'EACCES' });
    return rename(from, to);
  } });
  const unchanged = store.readSession('chat-7');
  const journal = await openTranscriptJournal(store);
  const writer = await journal.begin({ sessionId: 'chat-0', turnId: 'failed-save', users: [message('user', '保留问题')], title: '保留标题' });
  await writer.append(message('agent', '保留回答🙂'));
  await writer.appendUsage({ sessionUpdate: 'usage_update', usage: { totalTokens: 17 } });
  deny = true;
  await assert.rejects(writer.finalize(), { code: 'EACCES' });
  assert.deepEqual(store.readSession('chat-0').updates, []);
  assert.equal((await readdir(journal.directory)).length, 1);
  const fresh = await openStore(directory);
  const recovered = await openTranscriptJournal(fresh);
  assert.equal(recovered.recovered.length, 1);
  assert.deepEqual(fresh.readSession('chat-0').updates.map(row => row.content.text), ['保留问题', '保留回答🙂']);
  assert.equal(fresh.readSession('chat-0').title, '保留标题');
  assert.equal(fresh.readSession('chat-0').messageCount, 2);
  assert.equal(fresh.readSession('chat-0').usageUpdates[0].usage.totalTokens, 17);
  assert.deepEqual(fresh.readSession('chat-7'), unchanged);
  assert.equal((await openTranscriptJournal(await openStore(directory))).recovered.length, 0);
  await disk(fresh, directory);
});

for (const phase of ['partial-snapshot', 'before-replace', 'after-replace']) {
  test(`process killed ${phase} preserves recoverable chat and replays it once`, { timeout: 15000 }, async () => {
    const { directory, store } = await fixture();
    const baseline = store.read();
    const source = `
      import { rename, truncate } from 'node:fs/promises';
      import { openStore } from ${JSON.stringify(new URL('../store.mjs', import.meta.url).href)};
      import { openTranscriptJournal } from ${JSON.stringify(new URL('../transcripts.mjs', import.meta.url).href)};
      let armed = false;
      const store = await openStore(process.argv[1], { replaceFile: async (from, to) => {
        if (!armed) return rename(from, to);
        // Inject the exact disk state of an interrupted partial temporary write.
        // The real process is then killed while its fsynced journal still exists.
        if (process.argv[2] === 'partial-snapshot') await truncate(from, 23);
        if (process.argv[2] === 'after-replace') await rename(from, to);
        process.stdout.write('COMMIT_BARRIER\\n');
        await new Promise(() => { setInterval(() => {}, 1000); });
      }});
      const journal = await openTranscriptJournal(store);
      const writer = await journal.begin({ sessionId: 'chat-0', turnId: 'crash-${phase}', users: [${JSON.stringify(message('user', '恢复问题'))}], title: '恢复标题' });
      await writer.append(${JSON.stringify(message('agent', '恢复回答'))});
      await writer.appendUsage({ sessionUpdate: 'usage_update', status: { data: { fixture: 'terminal' } } });
      armed = true;
      await writer.finalize();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', value => { stderr += value; });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.on('data', value => { stdout += value; if (stdout.includes('COMMIT_BARRIER')) resolve(); });
        child.once('error', reject);
        child.once('exit', code => reject(Error(`Crash fixture exited early ${code}: ${stderr}`)));
      });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const fresh = await openStore(directory);
      assert.equal(fresh.readSession('chat-0').updates.length, phase === 'after-replace' ? 2 : 0);
      if (phase === 'partial-snapshot') {
        const orphan = (await readdir(directory)).find(name => /^state\.json\..*\.tmp$/.test(name));
        assert.ok(orphan, 'the partial snapshot remains a non-authoritative orphan');
        assert.equal((await readFile(join(directory, orphan))).length, 23);
      }
      const recovered = await openTranscriptJournal(fresh);
      assert.equal(recovered.recovered.length, 1);
      const saved = await disk(fresh, directory);
      assert.deepEqual(saved.sessions[0].updates.map(row => row.content.text), ['恢复问题', '恢复回答']);
      assert.equal(saved.sessions[0].messageCount, 2);
      assert.equal(saved.sessions[0].title, '恢复标题');
      assert.equal(saved.sessions[0].usageUpdates.length, 1);
      assert.deepEqual(saved.sessions.slice(1), baseline.sessions.slice(1));
      assert.deepEqual(saved.legacyFixture, baseline.legacyFixture);
      assert.equal((await openTranscriptJournal(await openStore(directory))).recovered.length, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
}

test('eight conversations ending together and an interleaved config write retain all turns exactly once', async () => {
  const { store, directory } = await fixture();
  const journal = await openTranscriptJournal(store);
  const writers = await Promise.all(Array.from({ length: 8 }, (_, i) => journal.begin({
    sessionId: `chat-${i}`, turnId: `parallel-${i}`, users: [message('user', `问题${i}`)], title: `标题${i}`,
  })));
  await Promise.all(writers.map(async (writer, i) => {
    await writer.append(message('agent', `回答${i}`));
    await writer.appendUsage({ sessionUpdate: 'usage_update', usage: { totalTokens: i + 1 } });
  }));
  await Promise.all([
    ...writers.map(writer => writer.finalize()),
    store.update(state => { state.preferences.parallel = true; }, ['preferences']),
  ]);
  const fresh = await openStore(directory);
  const saved = await disk(fresh, directory);
  for (const [i, session] of saved.sessions.entries()) {
    assert.deepEqual(session.updates.map(row => row.content.text), [`问题${i}`, `回答${i}`]);
    assert.equal(session.title, `标题${i}`);
    assert.equal(session.messageCount, 2);
    assert.equal(session.usageUpdates[0].usage.totalTokens, i + 1);
    assert.equal(Object.keys(session.transcriptTurns).length, 1);
  }
  assert.equal(saved.preferences.parallel, true);
  assert.equal((await openTranscriptJournal(fresh)).recovered.length, 0);
  assert.deepEqual(await readdir(journal.directory), []);
});
