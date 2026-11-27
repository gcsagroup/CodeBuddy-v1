import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createSpeechPlaybackServer } from '../speech-playback.mjs';

async function fixture(t, { raw = false, wait = false, status = 200, large = false } = {}) {
  const requests = []; let cancelled = false, finish;
  const remote = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); res.statusCode = status;
    if (status !== 200) { res.end('unavailable'); return; }
    if (wait && requests.length === 1) { res.on('close', () => { cancelled = true; }); finish = () => { res.setHeader('content-type', 'application/x-ndjson'); res.end(JSON.stringify({ event: 'chunk', sample_rate: 24000, audio_b64: Buffer.alloc(480).toString('base64') }) + '\n' + JSON.stringify({ event: 'done' })); }; return; }
    const pcm = Buffer.alloc(large ? 240000 : 480); pcm.writeInt16LE(100, 0);
    if (raw) { res.setHeader('content-type', 'audio/pcm'); res.write(pcm.subarray(0, 7)); res.end(pcm.subarray(7)); return; }
    res.setHeader('content-type', 'application/x-ndjson');
    const line = JSON.stringify({ event: 'chunk', sample_rate: 24000, audio_b64: pcm.toString('base64') });
    res.write(line.slice(0, 9)); res.end(line.slice(9) + '\n' + JSON.stringify({ event: 'done' }));
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const config = { REMOTE_TTS_URL: `http://127.0.0.1:${remote.address().port}/v1/audio/speech`, REMOTE_TTS_MODEL: 'configured-tts' };
  const server = createSpeechPlaybackServer({ read: () => ({ config: { SPEECH_SERVICES: { value: config } } }) });
  const local = http.createServer(); local.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws)));
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${local.address().port}`), events = [];
  client.on('message', data => events.push(JSON.parse(data)));
  t.after(async () => { client.terminate(); for (const ws of server.clients) ws.terminate(); server.close(); await new Promise(r => local.close(r)); remote.closeAllConnections(); await new Promise(r => remote.close(r)); });
  await once(client, 'open');
  const until = async predicate => { for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail(JSON.stringify(events)); };
  return { client, events, requests, until, cancelled: () => cancelled, finish: () => finish(), url: `ws://127.0.0.1:${local.address().port}`, config };
}

test('no synthesis before click; configured model and ordered segments stream PCM', async t => {
  const f = await fixture(t); assert.equal(f.requests.length, 0);
  const text = '这是第一段需要播报的内容。接下来还有第二段，最后完整结束。';
  f.client.send(JSON.stringify({ type: 'start', text })); await f.until(() => f.events.some(e => e.type === 'done'));
  assert.equal(f.requests.map(r => r.input).join(''), text);
  assert.ok(f.requests[0].input.length <= 16);
  assert.ok(f.requests.every(r => r.model === 'configured-tts' && r.stream && r.response_format === 'pcm'));
  assert.equal(f.events[0].type, 'audio');
});
test('check synthesizes a short sample but never sends playback audio', async t => {
  const f = await fixture(t); f.client.send(JSON.stringify({ type: 'check' }));
  await f.until(() => f.events.some(e => e.type === 'done'));
  assert.equal(f.requests.length, 1); assert.ok(!f.events.some(e => e.type === 'audio'));
});
test('punctuation-only fragments are not sent to TTS', async t => {
  const f = await fixture(t); f.client.send(JSON.stringify({ type: 'start', text: '！你好。' }));
  await f.until(() => f.events.some(e => e.type === 'done'));
  assert.deepEqual(f.requests.map(request => request.input), ['你好。']);
});
test('raw PCM handles odd HTTP chunk boundaries', async t => {
  const f = await fixture(t, { raw: true }); f.client.send(JSON.stringify({ type: 'start', text: '你好' }));
  await f.until(() => f.events.some(e => e.type === 'done'));
  const pcm = Buffer.concat(f.events.filter(e => e.type === 'audio').map(e => Buffer.from(e.audio, 'base64')));
  assert.equal(pcm.length, 480); assert.equal(pcm.readInt16LE(0), 100);
});
test('switching drains accepted old segment and queues next reply without cancelling remote worker', async t => {
  const f = await fixture(t, { wait: true }); f.client.send(JSON.stringify({ type: 'start', text: '旧回复。不要继续合成这一段。' }));
  await f.until(() => f.requests.length === 1);
  f.client.close(); await once(f.client, 'close');
  const next = new WebSocket(f.url), events = []; t.after(() => next.terminate());
  next.on('message', data => events.push(JSON.parse(data))); await once(next, 'open');
  next.send(JSON.stringify({ type: 'start', text: '新回复。' }));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.requests.length, 1); assert.equal(f.cancelled(), false);
  f.finish(); await f.until(() => events.some(event => event.type === 'done'));
  assert.deepEqual(f.requests.map(request => request.input), ['旧回复。', '新回复。']);
  assert.ok(!events.some(event => event.type === 'error'));
});
test('unavailable service emits a useful error without audio', async t => {
  const f = await fixture(t, { status: 503 }); f.client.send(JSON.stringify({ type: 'start', text: '你好' }));
  await f.until(() => f.events.some(e => e.type === 'error'));
  assert.match(f.events[0].message, /503/);
});
test('long audio waits for played acknowledgements before buffering more', async t => {
  const f = await fixture(t, { large: true }); f.client.send(JSON.stringify({ type: 'start', text: '你好' }));
  await f.until(() => f.events.length === 8);
  assert.ok(!f.events.some(e => e.type === 'done'));
  for (const event of [...f.events]) f.client.send(JSON.stringify({ type: 'played', id: event.id }));
  await f.until(() => f.events.some(e => e.type === 'done'));
  assert.equal(f.events.filter(e => e.type === 'audio').length, 10);
});
