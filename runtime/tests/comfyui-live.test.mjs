import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { consumeMediaEvent, watchMedia, mediaObservation, stopMedia } from '../comfyui-live.mjs';
const id = '7e2d6192-3392-4cdf-9c0e-48f48b35c2f3';
const text = (state, type, data) => consumeMediaEvent(state, Buffer.from(JSON.stringify({ type, data })), false, id);
function frame(prompt = id) {
  const meta = Buffer.from(JSON.stringify({ prompt_id: prompt, node_id: 'sample' }));
  const head = Buffer.alloc(8); head.writeUInt32BE(4); head.writeUInt32BE(meta.length, 4);
  return Buffer.concat([head, meta, Buffer.from([255,216,255,217])]);
}
test('progress remains prompt-scoped and all preview frames are ignored', () => {
  const state = {};
  text(state, 'progress', { prompt_id: 'another', value: 5, max: 10 }); assert.equal(state.step, undefined);
  text(state, 'executing', { prompt_id: id, node: 'sample' });
  text(state, 'progress', { prompt_id: id, value: 5, max: 20 }); assert.equal(state.step, 5);
  text(state, 'progress', { prompt_id: id, value: 30, max: 20 }); assert.equal(state.step, 5);
  consumeMediaEvent(state, frame('another'), true, id); assert.equal(state.preview, undefined);
  consumeMediaEvent(state, Buffer.alloc(3 * 1024 * 1024), true, id); assert.equal(state.preview, undefined);
  consumeMediaEvent(state, frame(), true, id); assert.equal(state.preview, undefined); assert.equal(state.previewAt, undefined);
  text(state, 'executing', { prompt_id: id, node: 'decode' }); assert.equal(state.step, undefined);
  assert.equal(state.status, undefined); // Observation never invents completion.
});
test('real WebSocket receives progress without requesting previews and releases/reconnects', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); stopMedia('fixture'); });
  let clientId, flags;
  server.on('connection', (socket, request) => {
    clientId = new URL(request.url, 'http://local').searchParams.get('clientId');
    socket.on('message', value => { flags = JSON.parse(value); });
    socket.send(JSON.stringify({ type: 'progress', data: { prompt_id: id, node: 'sample', value: 4, max: 20 } }));
    socket.send(frame());
  });
  const job = { job_id: id, prompt_id: id };
  await watchMedia('fixture', `http://127.0.0.1:${server.address().port}`, job);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(clientId, id); assert.equal(flags, undefined);
  assert.equal(mediaObservation('fixture').step, 4); assert.equal(mediaObservation('fixture').preview, undefined);
  stopMedia('fixture'); assert.equal(mediaObservation('fixture').connected, false);
  await watchMedia('fixture', `http://127.0.0.1:${server.address().port}`, job);
  assert.equal(mediaObservation('fixture').connected, true);
});
