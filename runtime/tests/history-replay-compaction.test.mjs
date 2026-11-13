import test from 'node:test';
import assert from 'node:assert/strict';
import { Compat } from '../compat.mjs';
import { projectChatUpdates as project } from './helpers/renderer-projection.mjs';

async function replay(updates) {
  const original = structuredClone(updates), emitted = [];
  const session = { id: 'history', cwd: 'C:\\isolated', type: 'user', title: 'history', readonlyHistory: true, updates };
  const state = { sessions: [session], providers: [], codeproRuns: [] };
  const store = { read: () => structuredClone(state) };
  const host = new Compat(store, {});
  await host.request('session/load', { sessionId: session.id }, { notify(method, value) {
    if (method === 'session/update') emitted.push(value.update);
  } });
  assert.deepEqual(updates, original, 'loading must not rewrite persisted history');
  assert.equal(emitted[0]?.sessionUpdate, 'session_info_update');
  assert.equal(emitted[0]?._meta?.goose?.transcriptReplayStarted, true,
    'the renderer must reset live replay before receiving compacted history');
  assert.deepEqual(await project(emitted), await project(original), 'all message content, metadata and tool order must survive replay');
  const reconciled=emitted.at(-1);
  assert.equal(reconciled?.sessionUpdate, 'session_info_update');
  assert.equal(reconciled?._meta?.goose?.activeRunId, null, 'history loading must clear a stale live run');
  return emitted.slice(1, -1);
}

const chunk = (kind, id, text, meta = {}) => ({ sessionUpdate: kind, messageId: id, content: { type: 'text', text }, _meta: { goose: { created: 123 }, ...meta } });

test('history assembles adjacent assistant text and thought deltas without crossing tools, users or metadata changes', async () => {
  const user = chunk('user_message_chunk', 'u', 'Review');
  const call = { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'read', kind: 'read', status: 'pending', rawInput: { file_path: 'src/main.ts' }, _meta: { goose: { toolCall: { toolName: 'read' } } } };
  const result = { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] };
  const updates = [user, chunk('agent_thought_chunk', 'a', 'Check '), chunk('agent_thought_chunk', 'a', 'logic'),
    chunk('agent_message_chunk', 'a', 'Before '), chunk('agent_message_chunk', 'a', 'tool'), call, result,
    chunk('agent_message_chunk', 'a', 'After '), chunk('agent_message_chunk', 'a', 'tool'),
    chunk('agent_message_chunk', 'a', 'different metadata', { marker: true }),
    chunk('agent_message_chunk', 'other', 'another message'), user];
  const emitted = await replay(updates);
  assert.equal(emitted.length, updates.length - 3);
  assert.deepEqual(emitted.filter(u => u.toolCallId), [call, result]);
  assert.deepEqual(emitted.filter(u => u.sessionUpdate === 'user_message_chunk'), [user, user]);
});

test('unnamed chunks, annotations, images and mode changes remain exact replay boundaries', async () => {
  const first = chunk('agent_message_chunk', 'a', 'A');
  const annotated = { ...chunk('agent_message_chunk', 'a', 'B'), content: { type: 'text', text: 'B', annotations: { audience: ['assistant'] } } };
  const image = { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' } };
  const unnamed = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unnamed' } };
  const mode = { sessionUpdate: 'current_mode_update', currentModeId: 'read-only' };
  const updates = [first, annotated, image, first, mode, first, unnamed, unnamed];
  assert.deepEqual(await replay(updates), updates);
});

test('bounded history frames retain all large text, split Unicode and literal tool-call strings', async () => {
  const parts = ['A'.repeat(50000), 'B'.repeat(50000), 'C'.repeat(10000), 'D'.repeat(10000),
    '\ud83d', '\ude00 中文 **Markdown** call:sub', 'agent{prompt:<|"|>text<|"|>}<tool_call|>'];
  const emitted = await replay(parts.map(text => chunk('agent_message_chunk', 'a', text)));
  assert.equal(emitted.map(u => u.content.text).join(''), parts.join(''));
  assert.ok(emitted.every(u => u.content.text.length <= 64 * 1024));
  assert.ok(emitted.every(u => u.sessionUpdate === 'agent_message_chunk'), 'literal text must never become an executable call');
  const large = chunk('agent_message_chunk', 'b', 'original'.repeat(12000));
  assert.deepEqual(await replay([large]), [large], 'preexisting large records are preserved');
});
