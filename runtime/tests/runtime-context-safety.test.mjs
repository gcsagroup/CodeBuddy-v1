import test from 'node:test';
import assert from 'node:assert/strict';
import '../harness/sdk-budget-contract.mjs';
const { Session, foldSurface, deriveEventMessage } = await import('../harness/node_modules/@deepseek-ai/dsh-session/lib/index.js');
const { createUserMessage, createAssistantMessage, LlmError, IMAGE_OFFLOAD_REQUIRED_CODE } = await import('../harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
const { TokenMeter } = await import('../harness/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js');
const { apply: applyImageOffload } = await import('../harness/node_modules/@deepseek-ai/dsh-compaction-image-offload/lib/index.js');

const snapshot = (session, text, source = { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'policy', text }] }) =>
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' });
const newMeter = () => Object.assign(Object.create(TokenMeter.prototype), { states: new WeakMap(), ctx: { get() {} } });

test('1,000 native snapshots stay bounded below pressure threshold; user inputs and raw audit history survive', () => {
  const session = Session.create('snapshot-stress'), meter = newMeter();
  const user = snapshot(session, 'Keep this exact user request.', { kind: 'user' });
  const snapshots = [];
  for (let step = 0; step < 1000; step++) {
    snapshots.push(snapshot(session, 'Current policy, cwd and role. '.repeat(30) + step));
    const visible = session.deriveMessages();
    assert.equal(visible.filter(m => m.source?.kind === 'runtime-context').length, 1);
    assert.deepEqual(visible[0], user.data);
    const measured = meter.measure(session);
    assert.equal(measured.surfaceTokens, visible.reduce((sum, message) => sum + meter.estimateMessage(message), 0));
    assert.ok(measured.totalTokens < 2048, 'independent of a large model window or pressure trigger');
  }
  assert.equal(session.snapshotEvents().filter(e => e.data.source?.kind === 'runtime-context').length, 1000);
  assert.equal(session.deriveEventMessage(snapshots[0]), null);
  assert.equal(session.surface.nodes.length, 1001, 'legacy positional compaction boundaries remain replayable');
  const restored = Session.create('snapshot-stress', session.snapshotEvents());
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
  const { logRevision: _restoredRevision, ...restoredMeter } = newMeter().measure(restored);
  const { logRevision: _liveRevision, ...liveMeter } = meter.measure(session);
  assert.deepEqual(restoredMeter, liveMeter);
  const fold = foldSurface(session.snapshotEvents());
  assert.deepEqual(fold.nodes.map(seq => deriveEventMessage(session.eventAt(seq), fold.projectedMessages)).filter(Boolean), session.deriveMessages());
});

test('cleared runtime state, partial fork prefixes and old compaction ranges cannot revive stale permissions', () => {
  const session = Session.create('snapshot-lifecycle');
  const old = snapshot(session, 'Permission: write allowed.');
  const user = snapshot(session, 'Never publish.', { kind: 'user' });
  const fresh = snapshot(session, 'Permission: read only.');
  const fork = Session.create('snapshot-fork', session.snapshotEvents().slice(0, fresh.seq));
  assert.match(fork.deriveMessages()[0].content[0].text, /write allowed/);
  assert.match(session.deriveMessages().at(-1).content[0].text, /read only/);
  const checkpoint = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Checkpoint' }], source: { kind: 'compact-checkpoint' } }),
    { surfaceOp: { op: 'replace', startSeq: fresh.seq, endSeq: fresh.seq }, sourceEventSeqs: [fresh.seq] });
  assert.equal(session.deriveEventMessage(old), null);
  assert.deepEqual(session.deriveMessages(), [user.data, checkpoint.data]);
  const cleared = snapshot(session, 'Current runtime context: none.', { kind: 'runtime-context' });
  assert.deepEqual(Session.create('snapshot-lifecycle', session.snapshotEvents()).deriveMessages(), [user.data, checkpoint.data, cleared.data]);
  // Legacy summaries may name a hidden runtime snapshot as the range start.
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Legacy checkpoint' }], source: { kind: 'compact-checkpoint' } }),
    { surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: user.seq }, sourceEventSeqs: [old.seq, user.seq] });
  assert.doesNotThrow(() => Session.create('snapshot-lifecycle', session.snapshotEvents()).deriveMessages());
});

test('cold replay cannot apply historical provider usage to a changed view; a fresh sample restores calibration', () => {
  const session = Session.create('snapshot-provider-usage'), meter = newMeter();
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture', maxTokens: 256 } } });
  session.append('turn/start', { turn: 1 });
  const reply = (step, usage) => session.append('assistant/message', { turn: 1, step, stream: [], usage,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Recorded answer.' }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  snapshot(session, 'Old context. '.repeat(100));
  reply(1, { inputTokens: 5000, outputTokens: 20 });
  session.append('step/end', { turn: 1, step: 1 });
  assert.equal(meter.measure(session).baseline.kind, 'usage');
  session.append('step/start', { turn: 1, step: 2 });
  snapshot(session, 'Current read-only policy.');
  assert.ok(meter.measure(session).totalTokens < 5020, 'projected removal reduces occupancy without changing prior billing');
  reply(2, { inputTokens: 600, outputTokens: 10 });
  session.append('step/end', { turn: 1, step: 2 });
  const restored = Session.create('snapshot-provider-usage', session.snapshotEvents()), restoredMeter = newMeter();
  const live = meter.measure(session), cold = restoredMeter.measure(restored);
  assert.equal(live.baseline.kind, 'usage');
  for (const key of ['surfaceTokens', 'nodes']) assert.deepEqual(cold[key], live[key]);
  assert.equal(cold.baseline.kind, 'estimated', 'a previous process cannot prove which projection its call sent');
  assert.equal(cold.totalTokens, cold.surfaceTokens, 'this header has no tools; only canonical messages contribute to the estimate');
  restored.append('step/start', { turn: 1, step: 3 });
  restored.append('assistant/message', { turn: 1, step: 3, stream: [], usage: { inputTokens: 700, outputTokens: 10 },
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Fresh call.' }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' });
  restored.append('step/end', { turn: 1, step: 3 });
  assert.equal(restoredMeter.measure(restored).baseline.kind, 'usage');
  assert.equal(restoredMeter.measure(restored).baseline.tokens, 710);
});

test('legacy 838K usage cannot keep 225 superseded snapshots in current pressure or alter billing facts', () => {
  const legacy = Session.create('legacy-context-usage');
  legacy.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture', maxTokens: 256 } } });
  legacy.append('turn/start', { turn: 1 });
  legacy.append('step/start', { turn: 1, step: 1 });
  for (let n = 0; n < 225; n++) snapshot(legacy, ('Old status ' + n + '. ').repeat(100));
  const usage = { inputTokens: 838257, outputTokens: 85 };
  const reply = legacy.append('assistant/message', { turn: 1, step: 1, stream: [], usage,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Recorded reply.' }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' });
  legacy.append('step/end', { turn: 1, step: 1 });
  const restored = Session.create('legacy-context-usage', legacy.snapshotEvents());
  const measured = newMeter().measure(restored);
  assert.equal(measured.baseline.kind, 'estimated');
  assert.ok(measured.totalTokens < 4096, 'current pressure follows the current request view rather than the old 838K payload');
  assert.deepEqual(restored.eventAt(reply.seq).data.usage, usage, 'historical billing remains unchanged');
});

test('source metadata limits supersession; prompt-looking user text and unknown context forms survive', () => {
  const session = Session.create('snapshot-ownership');
  const ordinary = snapshot(session, 'The following information describes your current session. runtime-context snapshot.', { kind: 'user' });
  const extension = snapshot(session, 'Unknown future context form.', { kind: 'runtime-context', form: 'extension-delta' });
  snapshot(session, 'Old full snapshot.');
  const latest = snapshot(session, 'Current full snapshot.');
  assert.deepEqual(session.deriveMessages(), [ordinary.data, extension.data, latest.data]);
  const large = 'Required safety policy. '.repeat(10_000);
  snapshot(session, large);
  assert.equal(session.deriveMessages().at(-1).content[0].text, large, 'required current state is never silently truncated');
});

test('native image offload skips hidden snapshots in both request and summary recovery and preserves cold replay', async () => {
  for (const trigger of ['agent/request-error', 'compaction/summary-error']) {
    const projections = [], handlers = new Map();
    applyImageOffload({ sessions: { registerMessageProjection: p => projections.push(p) },
      on(name, handler) { handlers.set(name, handler); } });
    const session = Session.create('snapshot-image-recovery', undefined, undefined, undefined, projections);
    const hidden = snapshot(session, 'Stale policy.');
    snapshot(session, 'Current required policy.');
    const image = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image',
      attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'fixture.png' } }] }), { surfaceOp: 'append' });
    const meter = newMeter(); meter.measure(session);
    const failure = { code: IMAGE_OFFLOAD_REQUIRED_CODE, offloadImages: 1, message: 'Synthetic image pressure' };
    const recover = signal => trigger === 'agent/request-error'
      ? handlers.get(trigger)({ agent: { session }, failure }, () => 'unhandled')
      : handlers.get(trigger)({ session, sourceEventSeqs: [...session.surface.nodes], error: new LlmError(failure.message, failure.code, { offloadImages: 1 }), signal }, () => 'unhandled');
    if (trigger === 'compaction/summary-error') {
      const abort = new AbortController(); abort.abort();
      assert.throws(() => recover(abort.signal), { name: 'AbortError' });
      assert.equal(session.snapshotEvents().filter(e => e.type === 'image/offload').length, 0);
    }
    const result = await recover(new AbortController().signal);
    assert.deepEqual(result, trigger === 'agent/request-error' ? { kind: 'retry' } : true);
    assert.equal(session.deriveEventMessage(hidden), null);
    assert.equal(session.deriveEventMessage(image).content[0].offloaded, true);
    const omission = session.snapshotEvents().findLast(e => e.type === 'image/offload');
    assert.deepEqual(omission.data.targets, [{ seq: image.seq, imageIndexes: [0] }]);
    assert.equal(await recover(new AbortController().signal), 'unhandled', 'no repeated omission or retry when images are already offloaded');
    const restored = Session.create('snapshot-image-recovery', session.snapshotEvents(), undefined, undefined, projections);
    assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
    assert.deepEqual(newMeter().measure(restored).nodes, meter.measure(session).nodes);
  }
});

test('legacy image omission records cannot resurrect a hidden snapshot and still validate image occurrences', () => {
  const projections = [];
  applyImageOffload({ sessions: { registerMessageProjection: p => projections.push(p) }, on() {} });
  const session = Session.create('snapshot-image-history', undefined, undefined, undefined, projections);
  const hidden = session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
    content: [{ type: 'text', text: 'Old permission: write allowed.' }, { type: 'image', attachment: {
      attachmentId: 'legacy-context-image', mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'fixture.png' } }] }), { surfaceOp: 'append' });
  snapshot(session, 'Current permission: read only.');
  session.append('image/offload', { targets: [{ seq: hidden.seq, imageIndexes: [0] }] });
  assert.equal(session.deriveEventMessage(hidden), null);
  assert.equal(session.deriveMessages().length, 1);
  assert.throws(() => session.append('image/offload', { targets: [{ seq: hidden.seq, imageIndexes: [9] }] }), /does not exist/);
  assert.equal(Session.create('snapshot-image-history', session.snapshotEvents(), undefined, undefined, projections).deriveMessages().length, 1);
});
