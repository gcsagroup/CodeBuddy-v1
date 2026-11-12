import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMediaWorkflow, canDeliverMediaDirectly } from '../harness/media-workflow-selection.mjs';

const workflows = [
  { id: 'saved:TextToVideo.json', label: 'TextToVideo', mode: 'text_to_video', compatible: true, dependencies_available: true, sha256: 'a' },
  { id: 'saved:video_minimax_h3_t2v.json', label: 'video_minimax_h3_t2v', mode: 'text_to_video', compatible: true, dependencies_available: true, sha256: 'b' },
];
const user = (text, id) => ({ type: 'user/message', seq: id, data: { id: `input-${id}`, source: { kind: 'user', rpcId: `rpc-${id}` }, content: [{ type: 'text', text }] } });
const start = { type: 'turn/start', data: {} };
function fixture(overrides = {}) {
  let events = [start, user('换用 video_minimax_h3_t2v', 1), start,
    user('再换回 TextToVideo 工作流，生成 5 秒、512×288 的视频：蓝色纸船在平静水面上缓慢漂动。不要参考图。', 2),
    { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Old workflow: video_minimax_h3_t2v' }] } }];
  const agent = { id: 'session', inbox: { nextStep: [] }, options: { provider: 'fixture', model: 'fixture' }, session: { requestHeader: () => ({ config: { provider: 'accepted-route', model: 'accepted-model' } }) } };
  const requests = [];
  const choice = { workflow_id: workflows[0].id, mode: 'text_to_video', reason: 'The current request names this saved file.' };
  const ctx = { sessionController: { inspect: async () => ({ events }) }, llm: { prepareCall: async config => ({ config,
    stream: async function* (options) {
      requests.push(options); overrides.onStream?.();
      yield* overrides.chunks ?? [ { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'selection', name: 'select_workflow', arguments: JSON.stringify(choice) } }, { type: 'finish', reason: { kind: 'tool-calls' } } ];
    },
  }) } };
  const select = extra => selectMediaWorkflow(ctx, agent, { workflows, kind: 'video', mode: 'text_to_video', referenceCount: 0, ...extra });
  return { ctx, agent, requests, select, events, setEvents: value => { events = value; } };
}

test('direct delivery requires current semantic scope and exactly one successful saved output', async () => {
  const f = fixture();
  const selected = await f.select();
  const value = { status: 'completed', workflow: { id: selected.receipt.workflow_id },
    workflow_selection: { ...selected.receipt, single_media_only: true }, images: [{ path: 'D:/test/1.png' }] };
  const eligible = receipt => canDeliverMediaDirectly(f.ctx, f.agent, receipt);
  assert.equal(await eligible(value), true);
  assert.equal(await eligible({ ...value, images: [], videos: [{ path: 'D:/test/1.mp4' }] }), true);
  for (const change of [
    { status: 'running' }, { status: 'failed' }, { status: 'cancelled' }, { error: 'failed' },
    { waiting_in_background: true }, { images: [] }, { images: [{ path: '' }] },
    { images: [{ path: 'a' }, { path: 'b' }] },
    { workflow_selection: selected.receipt },
    { workflow_selection: { ...value.workflow_selection, single_media_only: 'true' } },
    { workflow_selection: { ...value.workflow_selection, request_hash: 'old' } },
    { workflow_selection: { ...value.workflow_selection, request_ids: ['old'] } },
  ]) assert.equal(await eligible({ ...value, ...change }), false, JSON.stringify(change));
  f.agent.inbox.nextStep.push({ source: { kind: 'user' } });
  assert.equal(await eligible(value), false);
  f.agent.inbox.nextStep.length = 0;
  f.events.push(user('生成后再分析构图', 9));
  assert.equal(await eligible(value), false);
  f.setEvents([start]);
  assert.equal(await eligible(value), false);
});

test('a multi-image turn concludes only on the requested saved count and only for images-only scope', async () => {
  const f = fixture();
  const base = (await f.select()).receipt;
  const result = { status: 'completed', workflow: { id: base.workflow_id }, images: [{path: 'third.png'}],
    workflow_selection: { ...base, image_count: 3, images_only: true }, completed_image_count: 3 };
  const eligible = r => canDeliverMediaDirectly(f.ctx, f.agent, r);
  assert.equal(await eligible(result), true);
  assert.equal(await eligible({ ...result, completed_image_count: 2 }), false);
  assert.equal(await eligible({ ...result, workflow_selection: { ...result.workflow_selection, images_only: false } }), false);
  assert.equal(await eligible({ ...result, status: 'queued' }), false);
  f.events.push(user('Wait, change the third picture.', 5));
  assert.equal(await eligible(result), false);
});

test('image submission requires an interpreted count and rejects malformed counts', async () => {
  for (const count of [undefined, -1, '3', 1.5, 3, null]) {
    const choice = { workflow_id: workflows[0].id, mode: workflows[0].mode, reason: 'fixture', image_count: count, images_only: true };
    const f = fixture({chunks: [
      {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'scope', name: 'select_workflow', arguments: JSON.stringify(choice)}},
      {type: 'finish', reason: {kind: 'tool-calls'}},
    ]});
    const selection = f.select({ kind: 'image' });
    if (count === 3 || count === null) assert.equal((await selection).receipt.image_count, count);
    else await assert.rejects(selection, /image count/);
  }
});

test('the real switch-back request is isolated from old workflow choices and injected runtime context', async () => {
  const f = fixture(); const result = await f.select();
  assert.equal(result.workflow_name, 'TextToVideo');
  assert.deepEqual(result.receipt.request_ids, ['input-2']);
  const sent = f.requests[0];
  assert.equal(sent.provider, 'accepted-route'); assert.equal(sent.model, 'accepted-model');
  assert.equal(sent.messages.length, 1); assert.deepEqual(sent.tools.map(t => t.name), ['select_workflow']);
  const data = JSON.parse(sent.messages[0].content[0].text);
  assert.equal(data.request.length, 1); assert.match(data.request[0].text, /再换回 TextToVideo/);
  assert.equal(JSON.stringify(data).includes('Old workflow:'), false);
  await result.assertCurrent();
});

test('admitted steering stays ordered and invalidates an older selection before submission', async () => {
  const f = fixture(); f.events.push(user('保持 TextToVideo，但船改成绿色', 3));
  const selected = await f.select(); assert.deepEqual(selected.receipt.request_ids, ['input-2', 'input-3']);
  f.events.push(user('停止生成', 4));
  await assert.rejects(selected.assertCurrent(), /request changed/);
});

test('pending steering and missing admitted input cannot fall back to the tool proposal', async () => {
  const pending = fixture(); pending.agent.inbox.nextStep.push({ source: { kind: 'user' } });
  await assert.rejects(pending.select(), /pending admission/); assert.equal(pending.requests.length, 0);
  const missing = fixture(); missing.setEvents([start]);
  await assert.rejects(missing.select(), /admitted current request/); assert.equal(missing.requests.length, 0);
});

test('steering that arrives during interpretation prevents the old result from being used', async () => {
  let f; f = fixture({ onStream: () => f.events.push(user('改用其他工作流', 8)) });
  await assert.rejects(f.select(), /request changed/);
});

test('invalid, incomplete, missing and action responses do not authorize generation', async t => {
  const end = { type: 'finish', reason: { kind: 'stop' } };
  const text = text => ({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'selection', name: 'select_workflow', arguments: text } });
  for (const [name, chunks] of [
    ['invalid JSON', [text('Use TextToVideo'), end]],
    ['unknown file', [text('{"workflow_id":"missing","mode":"text_to_video","reason":"missing"}'), end]],
    ['ambiguous choice', [text('{"workflow_id":null,"mode":null,"reason":"two names without a selected one"}'), end]],
    ['truncated', [text('{}'), { type: 'finish', reason: { kind: 'max-tokens' } }]],
    ['no finish', [text('{}')]],
    ['tool call', [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'bad', name: 'shell', arguments: '{}' } }, end]],
  ]) await t.test(name, async () => { await assert.rejects(fixture({ chunks }).select()); });
});

test('the selected workflow cannot silently change the proposed mode or reference form', async () => {
  const f = fixture();
  await assert.rejects(f.select({ workflows: workflows.map(w => ({ ...w, compatible: false })) }), /incompatible with the proposed mode/);
});

test('aborted requests stop before the auxiliary model is called', async () => {
  const f = fixture(); const c = new AbortController(); c.abort();
  await assert.rejects(f.select({ signal: c.signal }), /abort/i); assert.equal(f.requests.length, 0);
});
