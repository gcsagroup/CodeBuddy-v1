import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';
import { spawn } from 'node:child_process';

const tool = { name: 'mcp__qwen_computer__click' };
test('window title is bound before discovery and isolated by prompt, including an explicitly unrestricted prompt', async t => {
  const { begin } = fixture(t), first = begin('named');
  const list = title => ({name: 'mcp__qwen_computer__list_apps', arguments: {window_title: title}});
  const scope = turn => turn.metadata()['codebuddy/desktop-control'].windowTitle;
  assert.equal(await first.execute(list('Parity Mac 1103'), () => scope(first)), 'Parity Mac 1103');
  await assert.rejects(first.execute(list(''), () => assert.fail('scope widened')), /already bound/);
  await assert.rejects(first.execute(list('Parity QA 472'), () => assert.fail('scope replaced')), /already bound/);
  assert.equal(await first.execute(tool, () => scope(first)), 'Parity Mac 1103');
  await first.end();
  const second = begin('general');
  assert.equal(await second.execute(list(''), () => scope(second)), '');
});
function nativeCall(turn, outcome, { name = tool.name, fail = false, version = 1 } = {}) {
  const call = { name };
  return turn.execute(call, async () => {
    call.desktopControlReceipt = { schema_version: version, outcome };
    if (fail) throw Error('native failure');
    return 'native receipt';
  });
}

test('native lease rejection stops only its desktop turn and releases a queued healthy chat', async t => {
  const { host, begin } = fixture(t), a = begin('broken'), b = begin('healthy');
  await a.execute({ name: 'mcp__qwen_computer__list_apps' }, async () => 'owned');
  let dispatched = 0;
  const queued = b.execute(tool, async () => { dispatched++; return 'healthy'; });
  await delay(100);
  await assert.rejects(nativeCall(a, 'control_unavailable', { fail: true }), /DESKTOP_UNAVAILABLE/);
  assert.equal(await queued, 'healthy');
  assert.equal(dispatched, 1);
  assert.equal(host.state().paused, false, 'connection failure is not a global human takeover');
  assert.equal(a.controller.signal.aborted, false);
  for (let i = 0; i < 5; i++)
    await assert.rejects(a.execute(tool, async () => assert.fail('broken native connection retried')), /DESKTOP_UNAVAILABLE/);
  assert.equal(await a.execute({ name: 'write_file' }, async () => 'continued'), 'continued');
});

test('three native conflicts stop desktop only; refreshes and unrelated errors do not erase the streak', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  await nativeCall(a, 'input_conflict');
  await nativeCall(a, 'action_completed', { name: 'mcp__qwen_computer__get_app_state' });
  await assert.rejects(a.execute({ ...tool }, async () => { throw Error('DESKTOP_INPUT_CONFLICT text without native fact'); }));
  await nativeCall(a, 'input_conflict', { version: 2 });
  await assert.rejects(nativeCall(a, 'input_conflict', { fail: true }), /native failure/);
  assert.equal(host.state().paused, false);
  await assert.rejects(nativeCall(a, 'input_conflict'), e => e.desktopOutcome === 'stopped');
  assert.equal(host.state().pauseReason, 'input_conflicts');
  assert.equal(host.readLease(), null, 'native lease released; historical context is not ownership');
  assert.equal(a.controller.signal.aborted, false);
  await assert.rejects(a.execute(tool, async () => assert.fail('replayed click')), /DESKTOP_STOPPED/);
  assert.equal(await a.execute({ name: 'write_file' }, async () => 'done'), 'done');
});

test('actual successful input resets the streak, while list and observation do not', async t => {
  const { begin, host } = fixture(t), a = begin('A');
  for (let round = 0; round < 3; round++) {
    await nativeCall(a, 'input_conflict');
    await nativeCall(a, 'input_conflict');
    await nativeCall(a, 'action_completed');
  }
  await nativeCall(a, 'input_conflict');
  await nativeCall(a, 'action_completed', { name: 'mcp__qwen_computer__list_apps' });
  await nativeCall(a, 'input_conflict');
  assert.equal(host.state().paused, false);
  await assert.rejects(nativeCall(a, 'input_conflict'), /DESKTOP_STOPPED/);
});

test('third conflict fences other chats and old queued messages without replay; only new input starts again', async t => {
  const { host, begin, directory } = fixture(t), a = begin('A'), b = begin('B'), c = begin('C');
  const oldGeneration = host.state().generation;
  await nativeCall(a, 'input_conflict');
  const pending = [b, c].map(turn => assert.rejects(turn.execute(tool, async () => assert.fail('queued input ran')), /DESKTOP_STOPPED/));
  await delay(100);
  assert.equal(host.state().queue.length, 2);
  await nativeCall(a, 'input_conflict');
  await assert.rejects(nativeCall(a, 'input_conflict', { fail: true }), /DESKTOP_STOPPED/);
  await Promise.all(pending);
  for (const turn of [a, b, c]) assert.equal(await turn.execute({ name: 'read_file' }, async () => 'independent'), 'independent');
  const peer = new DesktopCoordinator({ directory });
  assert.equal(peer.state().pauseReason, 'input_conflicts');
  const fresh = begin('new');
  await host.preparePrompt('new', { token: 'new' });
  await nativeCall(fresh, 'action_completed');
  const late = begin('old-queued');
  await host.preparePrompt('old-queued', { token: 'old-queued', generation: oldGeneration });
  await assert.rejects(late.execute(tool, async () => assert.fail('old queued message revived')), /DESKTOP_STOPPED/);
  for (const turn of [a, b, c]) await assert.rejects(turn.execute(tool, async () => assert.fail()), /DESKTOP_STOPPED/);
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-coordinator-'));
  const states = [], host = new DesktopCoordinator({ directory, notify: s => states.push(s) });
  const handles = [];
  const begin = id => {
    const controller = new AbortController();
    const handle = host.begin({ sessionId: id, token: id, title: id, signal: controller.signal });
    handles.push({ controller, handle });
    return { ...handle, controller };
  };
  t.after(async () => { for (const h of handles) h.controller.abort(); await Promise.all(handles.map(h => h.handle.end())); });
  return { host, directory, states, begin };
}

test('manual pause fences only desktop tools; ordinary work and parent signal survive', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  await a.execute(tool, async () => 'clicked');
  assert.equal(host.pause('A', 'A'), true);
  assert.equal(a.controller.signal.aborted, false);
  await assert.rejects(a.execute(tool, async () => assert.fail('input after takeover')), /DESKTOP_PAUSED/);
  assert.equal(await a.execute({ name: 'read_file' }, async () => 'read'), 'read');
});

test('native Escape stops desktop calls without cancelling the task or trapping later calls', async t => {
  const { host, begin } = fixture(t), a = begin('A'), b = begin('B');
  await a.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => ({}));
  host.hold('escape');
  host.publish();
  assert.equal(a.controller.signal.aborted, false);
  assert.equal(b.controller.signal.aborted, false);
  for (let i = 0; i < 3; i++)
    await assert.rejects(a.execute(tool, async () => assert.fail('input after Escape')),
      error => error.desktopOutcome === 'stopped' && /DESKTOP_STOPPED/.test(error.message));
  assert.equal(await a.execute({ name: 'read_file' }, async () => 'independent work'), 'independent work');
  await a.end();
  await host.preparePrompt('A');
  const fresh = begin('fresh-A');
  assert.equal(await fresh.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => 'fresh observation'), 'fresh observation');
});

test('repeated desktop proposals wait locally; resume rejects stale input instead of replaying', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  await a.execute(tool, async () => {});
  const generation = a.metadata()['codebuddy/desktop-control'].generation;
  host.pause('A', 'A');
  await assert.rejects(a.execute(tool, async () => assert.fail()), /DESKTOP_PAUSED/);
  let settled = false;
  const pending = assert.rejects(a.execute(tool, async () => assert.fail()), /OBSERVATION_EXPIRED/).then(() => { settled = true; });
  await delay(100); assert.equal(settled, false);
  await host.resume(host.state().revision);
  await pending;
  await a.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => {});
  assert.notEqual(a.metadata()['codebuddy/desktop-control'].generation, generation);
});

test('two conversations retain coherent episodes and queue without interleaved input', async t => {
  const { host, begin } = fixture(t), a = begin('A'), b = begin('B'), actions = [];
  await a.execute(tool, async () => actions.push('A1'));
  const pending = b.execute(tool, async () => actions.push('B1'));
  await delay(100);
  assert.deepEqual(actions, ['A1']); assert.equal(host.state().queue[0].sessionId, 'B');
  await a.execute(tool, async () => actions.push('A2'));
  await a.end(); await pending;
  assert.deepEqual(actions, ['A1', 'A2', 'B1']);
});

test('Escape releases queued desktop calls so every chat can continue independent work', async t => {
  const { host, begin } = fixture(t), a = begin('A'), b = begin('B'), c = begin('C');
  await a.execute(tool, async () => {});
  const waiting = [b, c].map(turn => assert.rejects(
    turn.execute(tool, async () => assert.fail('queued chat stole the desktop')),
    error => error.desktopOutcome === 'stopped'));
  await delay(90);
  host.pause('A', 'A', 'escape');
  await Promise.all(waiting);
  for (const turn of [a, b, c]) {
    assert.equal(turn.controller.signal.aborted, false);
    assert.equal(await turn.execute({ name: 'read_file' }, async () => 'continued'), 'continued');
    await assert.rejects(turn.execute(tool, async () => assert.fail()), { desktopOutcome: 'stopped' });
  }
});

test('a new explicit chat can use the released desktop without reviving interrupted chats', async t => {
  const { host, begin } = fixture(t), old = begin('old');
  await old.execute(tool, async () => {});
  host.pause('old', 'old', 'escape');
  for (const id of ['new-1', 'new-2', 'new-3']) {
    const turn = begin(id);
    await host.preparePrompt(id, { token: id });
    assert.equal(host.state().paused, false, 'finished native cleanup releases the desktop while the old task still runs');
    await assert.rejects(old.execute(tool, async () => assert.fail('old chat revived')), { desktopOutcome: 'stopped' });
    assert.equal(await turn.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => id), id);
    assert.equal(host.pause('old', 'old', 'escape'), false, 'late Escape cannot stop the new owner');
    host.pause(id, id, 'escape');
    assert.equal(turn.controller.signal.aborted, false);
  }
});

test('human takeover fences queued B even when A finishes', async t => {
  const { host, begin } = fixture(t), a = begin('A'), b = begin('B');
  await a.execute(tool, async () => {});
  const pending = assert.rejects(b.execute(tool, async () => assert.fail('B stole mouse')), /DESKTOP_PAUSED/);
  await delay(90); host.pause('A', 'A'); await a.end(); await pending;
  assert.equal(host.state().paused, true);
});

test('queue withdrawal is local, not task cancellation', async t => {
  const { host, begin } = fixture(t), a = begin('A'), b = begin('B');
  await a.execute(tool, async () => {});
  const pending = assert.rejects(b.execute(tool, async () => assert.fail()), /DESKTOP_WITHDRAWN/);
  await delay(90); host.withdraw('B', 'B'); await pending;
  assert.equal(b.controller.signal.aborted, false); assert.equal(host.state().owner.sessionId, 'A');
});

test('physical pause marker blocks in-flight receipt and resume waits for cleanup', async t => {
  const { host, directory, begin } = fixture(t), a = begin('A');
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const pending = assert.rejects(a.execute(tool, async () => { started.resolve(); await gate.promise; return 'old image'; }), /DESKTOP_PAUSED/);
  await started.promise;
  writeFileSync(join(directory, 'paused'), 'physical-input');
  await assert.rejects(host.resume('physical-input'), /收尾/);
  gate.resolve(); await pending;
  assert.equal(a.controller.signal.aborted, false);
});

test('late Esc token and late resume cannot affect replacement owner', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  await a.execute(tool, async () => {}); await a.end();
  const b = begin('B'); await b.execute(tool, async () => {});
  assert.equal(host.pause('A', 'A'), false); assert.equal(host.state().paused, false);
  host.pause('B', 'B'); await assert.rejects(host.resume('old'), /状态已变化/);
});

test('profiles share a lease and a persistent takeover marker', async t => {
  const { directory, host, begin } = fixture(t), a = begin('A');
  const other = new DesktopCoordinator({ directory });
  await a.execute(tool, async () => {});
  assert.equal(other.state().owner.token, 'A');
  other.pause('A', 'A');
  assert.equal(host.state().paused, true);
  assert.equal(new DesktopCoordinator({ directory }).state().paused, true);
});

test('another coordinator cannot miss a short takeover and later reacquire with an old turn', async t => {
  const { directory, host, begin } = fixture(t), a = begin('A');
  const other = new DesktopCoordinator({ directory }), signal = new AbortController();
  const old = other.begin({ sessionId: 'other', token: 'old-other', signal: signal.signal });
  t.after(async () => { signal.abort(); await old.end(); });
  await a.execute(tool, async () => {});
  host.pause('A', 'A', 'escape');
  await host.preparePrompt('A', { activeInput: true, token: 'A' });
  await assert.rejects(old.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => assert.fail('missed takeover')),
    { desktopOutcome: 'stopped' });
  assert.equal(await old.execute({ name: 'read_file' }, async () => 'continued'), 'continued');
  await other.preparePrompt('other', { activeInput: true, token: 'old-other' });
  assert.equal(await old.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => 'fresh'), 'fresh');
});

test('missed takeover also withdraws pending desktop approval without affecting other approvals', async t => {
  const { directory, host, begin } = fixture(t), a = begin('A');
  const other = new DesktopCoordinator({ directory }), parent = new AbortController();
  const old = other.begin({ sessionId: 'other', token: 'old', signal: parent.signal });
  t.after(async () => { parent.abort(); await old.end(); });
  let desktopSignal, ordinarySignal;
  const pending = old.admit(tool, signal => { desktopSignal = signal; return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }); });
  const rejected = assert.rejects(pending, { desktopOutcome: 'stopped' });
  const ordinary = old.admit({ name: 'write_file' }, async signal => { ordinarySignal = signal; return 'approved'; });
  await a.execute(tool, async () => {});
  host.pause('A', 'A', 'escape');
  await host.preparePrompt('A', { activeInput: true, token: 'A' });
  other.publish();
  assert.equal(desktopSignal.aborted, true);
  assert.equal(ordinarySignal.aborted, false);
  assert.equal(await ordinary, 'approved');
  await rejected;
});

test('queued messages composed before Escape cannot silently reacquire the desktop', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  const queuedGeneration = host.state().generation;
  await a.execute(tool, async () => {});
  host.pause('A', 'A', 'escape');
  const afterEscape = host.state().generation;
  assert.notEqual(afterEscape, queuedGeneration);
  a.controller.abort(); await a.end();
  const queued = begin('queued');
  await host.preparePrompt('queued', { token: 'queued', generation: queuedGeneration });
  await assert.rejects(queued.execute(tool, async () => assert.fail('old queue reclaimed desktop')), { desktopOutcome: 'stopped' });
  assert.equal(await queued.execute({ name: 'write_file' }, async () => 'independent file'), 'independent file');
  const fresh = begin('fresh');
  await host.preparePrompt('fresh', { token: 'fresh', generation: afterEscape });
  assert.equal(await fresh.execute(tool, async () => 'fresh observation'), 'fresh observation');
  await assert.rejects(queued.admit(tool, async () => assert.fail('old queue revived')), { desktopOutcome: 'stopped' });
});

test('same-owner parallel calls serialize; ordinary task stop remains abortable', async t => {
  const { begin } = fixture(t), a = begin('A');
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const calls = [];
  const first = a.execute(tool, async () => { calls.push(1); started.resolve(); await gate.promise; });
  await started.promise;
  const second = assert.rejects(a.execute(tool, async () => calls.push(2)));
  a.controller.abort(); gate.resolve(); await assert.rejects(first); await second;
  assert.deepEqual(calls, [1]);
});

test('another runtime process cannot enter until the owning episode ends', async t => {
  const { directory, begin } = fixture(t), a = begin('A');
  await a.execute(tool, async () => {});
  const source = `import { DesktopCoordinator } from ${JSON.stringify(new URL('../desktop-coordinator.mjs', import.meta.url).href)};
    const host = new DesktopCoordinator({ directory: process.argv[1], notify: s => { if(s.queue.length) console.log('queued'); } });
    const turn = host.begin({ sessionId: 'child', token: 'child' });
    await turn.execute({ name: 'mcp__qwen_computer__click' }, async () => console.log('entered'));
    await turn.end();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  const queued = Promise.withResolvers();
  child.stdout.on('data', chunk => { output += chunk; if(output.includes('queued')) queued.resolve(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  await queued.promise;
  assert.equal(output.includes('entered'), false);
  await a.end();
  assert.equal(await done, 0, errors);
  assert.equal(output.match(/entered/g)?.length, 1);
});

test('lost or corrupt lease fails closed until explicit recovery', async t => {
  const { host, directory, begin } = fixture(t), a = begin('A');
  writeFileSync(join(directory, 'lease.json'), '{partial');
  await assert.rejects(a.execute(tool, async () => assert.fail('input with unknown owner')), /DESKTOP_PAUSED/);
  const restored = new DesktopCoordinator({ directory });
  assert.equal(restored.state().paused, true);
  await restored.resume(restored.state().revision);
  await host.preparePrompt('A', { activeInput: true, token: 'A' });
  await a.execute({name: 'mcp__qwen_computer__get_app_state'}, async () => 'fresh');
  assert.equal(host.state().owner.sessionId, 'A');
});

test('deep recovery: valid JSON with an invalid lease shape pauses instead of waiting forever', async t => {
  for (const lease of [null, {}, [], { version: 1, pid: 'not-a-pid', sessionId: 'old', token: 'old', generation: 'old' }]) {
    const { host, directory, begin } = fixture(t), turn = begin('new');
    writeFileSync(join(directory, 'lease.json'), JSON.stringify(lease));
    const pending = turn.execute(tool, async () => assert.fail('invalid lease admitted input'));
    const outcome = pending.then(() => 'executed', error => error.message);
    const observed = await Promise.race([outcome, delay(300).then(() => 'stuck')]);
    turn.controller.abort();
    await outcome;
    assert.match(observed, /DESKTOP_PAUSED/, JSON.stringify(lease));
    assert.equal(host.state().owner, null);
    await host.resume(host.state().revision);
    assert.equal(host.state().paused, false);
  }
});

test('deep recovery: cancelled desktop turn releases ownership without offering to restart it', async t => {
  const { host, begin } = fixture(t), turn = begin('cancelled');
  await turn.execute(tool, async () => {});
  host.pause('cancelled', 'cancelled');
  turn.controller.abort();
  await turn.end();
  assert.equal(host.state().paused, false, 'completed cancellation must not block future tasks');
  assert.equal(host.state().owner, null, 'a cancelled task is not a continuation target');
  const next = begin('next');
  assert.equal(await next.execute(tool, async () => 'next'), 'next');
});

test('deep recovery: late cancellation retires only the matching saved turn across restart', async t => {
  const { host, directory, begin } = fixture(t), turn = begin('saved');
  await turn.execute(tool, async () => {});
  host.pause('saved', 'saved');
  await turn.end();
  host.discardContinuation('saved', 'older-token');
  assert.equal(host.state().owner.sessionId, 'saved');
  host.discardContinuation('saved', 'saved');
  const restarted = new DesktopCoordinator({ directory });
  assert.equal(restarted.state().owner, null);
  assert.equal(restarted.state().paused, false);
});

test('new explicit prompt releases an ended pause without restarting the old chat', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  await a.execute(tool, async () => {});
  host.pause('A', 'A', 'manual');
  await host.preparePrompt('A');
  assert.equal(host.state().paused, true, 'live episode remains fenced');
  await a.end();
  await host.preparePrompt('B');
  assert.equal(host.state().paused, false);
  assert.equal(host.state().owner, null, 'new prompt does not replay the old task');
});

test('new prompt retires idle legacy markers without requiring a global unlock UI', async t => {
  const { host, directory } = fixture(t);
  for (const reason of ['mouse', 'keyboard', 'cancelled']) {
    host.hold(reason);
    await host.preparePrompt('new');
    assert.equal(host.state().paused, false);
  }
  writeFileSync(join(directory, 'paused'), 'unknown-old-marker');
  await host.preparePrompt('new');
  assert.equal(host.state().paused, false);
});

test('accepted input can continue its own paused live chat, but not a different live chat', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  await a.execute(tool, async () => {});
  host.pause('A', 'A', 'manual');
  await host.preparePrompt('B', { activeInput: true });
  assert.equal(host.state().paused, true);
  await host.preparePrompt('A', { activeInput: true });
  assert.equal(host.state().paused, false);
  assert.equal(host.state().owner, null, 'fresh observation must acquire a new lease');
});

test('new explicit input cannot release a paused action before its native cleanup', async t => {
  const { host, begin } = fixture(t), a = begin('A');
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const action = a.execute(tool, async () => { entered.resolve(); await finish.promise; });
  const rejected = assert.rejects(action, /DESKTOP_STOPPED/);
  await entered.promise;
  host.pause('A', 'A', 'escape');
  await host.preparePrompt('A', { activeInput: true });
  assert.equal(host.state().paused, true);
  finish.resolve();
  await rejected;
  assert.equal(a.controller.signal.aborted, false);
  assert.equal(await a.execute({ name: 'read_file' }, async () => 'continued'), 'continued');
  await a.end();
  await host.preparePrompt('A');
  assert.equal(host.state().paused, false);
});

test('pause reasons survive restart and old markers remain recoverable', async t => {
  const { host, directory, begin } = fixture(t), turn = begin('reason');
  await turn.execute(tool, async () => {});
  host.pause('reason', 'reason', 'escape');
  const restarted = new DesktopCoordinator({ directory });
  assert.equal(restarted.state().pauseReason, 'escape');
  const revision = restarted.state().revision;
  host.pause('reason', 'reason', 'mouse');
  assert.equal(host.state().revision, revision, 'first takeover stays authoritative');
  assert.equal(host.state().pauseReason, 'escape');
  await host.resume(revision);
  writeFileSync(join(directory, 'paused'), 'legacy-human');
  assert.equal(host.state().revision, 'legacy-human');
  assert.equal(host.state().pauseReason, 'unknown');
  await host.resume('legacy-human');
});
