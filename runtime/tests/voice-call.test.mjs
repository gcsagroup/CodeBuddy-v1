import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createVoiceCallServer, validateVoiceWav } from '../voice-call.mjs';

function wav() {
  const b = Buffer.alloc(6444); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(6400, 40); return b;
}
async function fixture(t, options = {}) {
  const requests = []; let cancelled = false;
  const remote = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined; requests.push({ path: req.url, body });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gemma-4-e2b-voice' }] }));
    if (req.url === '/health') return res.end(JSON.stringify({ ready: options.ready !== false }));
    if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'text/event-stream');
      if (body.max_tokens === 256) {
        if (options.transcriptionFailure) { res.statusCode = 503; res.end('unavailable'); return; }
        if (options.waitTranscription) { res.on('close', () => { cancelled = true; }); return; }
        const marker = Buffer.from(body.messages[1].content[0].input_audio.data, 'base64').readInt16LE(44);
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: options.longTranscript ? '很长的用户发言'.repeat(100) : `用户发言${marker}` }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好，' } }] }) + '\n\n');
      if (options.wait) { res.on('close', () => { cancelled = true; }); return; }
      res.end('data: [DONE]\n\n'); return;
    }
    res.setHeader('content-type', 'application/x-ndjson');
    res.end(JSON.stringify({ event: 'chunk', audio_b64: Buffer.alloc(480).toString('base64'), sample_rate: 24000 }) + '\n' + JSON.stringify({ event: 'done' }) + '\n');
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const endpoint = `http://127.0.0.1:${remote.address().port}`;
  const calls = createVoiceCallServer({ llmEndpoint: endpoint, ttsEndpoint: endpoint });
  const local = http.createServer();
  local.on('upgrade', (req, socket, head) => calls.handleUpgrade(req, socket, head, ws => calls.emit('connection', ws)));
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${local.address().port}`);
  t.after(async () => { client.terminate(); for (const ws of calls.clients) ws.terminate(); calls.close(); await new Promise(r => local.close(r)); remote.closeAllConnections(); await new Promise(r => remote.close(r)); });
  await once(client, 'open');
  const messages = []; client.on('message', data => messages.push(JSON.parse(data.toString())));
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail(JSON.stringify(messages)); };
  client.send(JSON.stringify({ type: 'start', persona: { name: 'Miya', prompt: '称呼用户为Master。' } }));
  await until(() => messages.length);
  return { client, messages, requests, until, cancelled: () => cancelled };
}
test('native audio reaches Gemma and streamed text reaches TTS with persona intact', async t => {
  const { client, messages, requests, until } = await fixture(t);
  assert.equal(messages[0].type, 'ready'); client.send(wav());
  await until(() => messages.some(m => m.type === 'done'));
  const llm = requests.find(r => r.path === '/v1/chat/completions').body;
  assert.match(llm.messages[0].content, /Miya/); assert.match(llm.messages[0].content, /Master/);
  assert.deepEqual(Buffer.from(llm.messages[1].content[0].input_audio.data, 'base64'), wav());
  assert.equal(requests.find(r => r.path === '/v1/audio/speech').body.input, '你好，');
  assert.ok(messages.find(m => m.type === 'text')); assert.ok(messages.find(m => m.type === 'audio'));
});
test('unready TTS prevents entering call mode', async t => {
  const { messages } = await fixture(t, { ready: false }); assert.equal(messages[0].type, 'error');
});
test('interrupt cancels generation and suppresses stale results', async t => {
  const { client, messages, until, cancelled } = await fixture(t, { wait: true });
  client.send(wav()); await until(() => messages.some(m => m.type === 'text'));
  client.send(JSON.stringify({ type: 'interrupt' })); await until(cancelled);
  assert.ok(!messages.some(m => m.type === 'turn-error' || m.type === 'done'));
});
test('hangup cancels remote generation', async t => {
  const { client, messages, until, cancelled } = await fixture(t, { wait: true });
  client.send(wav()); await until(() => messages.some(m => m.type === 'text')); client.close(); await until(cancelled);
});
test('reject malformed audio before inference', () => {
  assert.throws(() => validateVoiceWav(Buffer.alloc(44)));
  const b = wav(); b.writeUInt32LE(48000, 24); assert.throws(() => validateVoiceWav(b));
});

function audioOf(request) {
  return Buffer.from(request.body.messages.at(-1).content.find(b => b.type === 'input_audio').input_audio.data, 'base64');
}

test('sliding window retains three text turns, evicts oldest and sends only current audio', async t => {
  const { client, messages, requests, until } = await fixture(t);
  for (let turn = 1; turn <= 5; turn++) {
    const audio = wav(); audio.writeInt16LE(turn * 100, 44); client.send(audio);
    await until(() => messages.filter(m => m.type === 'done').length === turn);
  }
  const replies = requests.filter(r => r.body?.max_tokens === 128);
  assert.equal(replies.length, 5);
  const last = replies[4], audio = audioOf(last);
  validateVoiceWav(audio);
  assert.equal(audio.readInt16LE(44), 500);
  assert.equal(audio.length, wav().length);
  const users = last.body.messages.filter(m => m.role === 'user' && typeof m.content === 'string').map(m => m.content);
  assert.deepEqual(users, ['用户发言200', '用户发言300', '用户发言400']);
  assert.equal(last.body.messages.filter(m => m.role === 'assistant').length, 3);
  assert.ok(requests.filter(r => r.path === '/v1/chat/completions').every(r => [128, 256].includes(r.body.max_tokens)));
});

test('interruption retains transcribed user facts without claiming generated reply was heard', async t => {
  const { client, messages, requests, until } = await fixture(t, { wait: true });
  const first = wav(); first.writeInt16LE(123, 44);
  client.send(first); await until(() => messages.some(m => m.type === 'text'));
  client.send(JSON.stringify({ type: 'interrupt' })); client.send(wav());
  await until(() => requests.filter(r => r.body?.max_tokens === 128).length === 2);
  const second = requests.filter(r => r.body?.max_tokens === 128)[1];
  assert.equal(second.body.messages[1].content, '用户发言123');
  assert.match(second.body.messages[0].content, /不保证已经播放/);
});

test('history transcription failure logs only and next native audio reply still works', async t => {
  const { client, messages, requests, until } = await fixture(t, { transcriptionFailure: true });
  const logs = []; t.mock.method(console, 'warn', (...args) => logs.push(args));
  client.send(wav()); await until(() => logs.length);
  client.send(wav()); await until(() => messages.filter(m => m.type === 'done').length === 2);
  assert.equal(requests.filter(r => r.body?.max_tokens === 128).length, 2);
  assert.ok(!messages.some(m => m.type === 'error' || m.type === 'turn-error'));
  assert.match(JSON.stringify(logs), /transcription-failed/);
});

test('oversized historical turn is evicted whole while current audio is intact', async t => {
  const { client, messages, requests, until } = await fixture(t, { longTranscript: true });
  client.send(wav()); await until(() => messages.some(m => m.type === 'done'));
  client.send(wav()); await until(() => messages.filter(m => m.type === 'done').length === 2);
  const second = requests.filter(r => r.body?.max_tokens === 128)[1];
  assert.equal(second.body.messages.length, 2);
  assert.deepEqual(audioOf(second), wav());
});

test('hangup cancels background history transcription', async t => {
  const { client, requests, until, cancelled } = await fixture(t, { waitTranscription: true });
  client.send(wav()); await until(() => requests.some(r => r.body?.max_tokens === 256));
  client.close(); await until(cancelled);
});
