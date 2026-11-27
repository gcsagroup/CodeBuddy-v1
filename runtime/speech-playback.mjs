import { WebSocket, WebSocketServer } from 'ws';
import { revealSecret } from './secrets.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export function speechSegments(text) {
  const result = []; let rest = text.trim();
  while (rest) {
    const limit = result.length ? 90 : 16;
    const head = rest.slice(0, limit), match = /[。！？!?；;，,\n]/u.exec(head);
    let end = match ? match.index + 1 : Math.min(rest.length, limit);
    if (end < rest.length && /[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
    const segment = rest.slice(0, end);
    if (/[\p{L}\p{N}]/u.test(segment)) result.push(segment);
    rest = rest.slice(end).trimStart();
  }
  return result.filter(value => value.trim());
}

function connection(store) {
  const config = store.read(['config']).config ?? {};
  const settings = config.SPEECH_SERVICES?.value ?? {};
  const endpoint = new URL(settings.REMOTE_TTS_URL ?? 'http://192.168.50.231:18004/v1/audio/speech');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error('语音合成接口地址无效，请在设置中填写 HTTP(S) 地址。');
  const model = settings.REMOTE_TTS_MODEL ?? 'Qwen3-TTS-12Hz-0.6B-Base-INT4';
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error('请配置语音合成模型名称。');
  return { endpoint, model: model.trim(), secret: config.REMOTE_TTS_API_KEY?.secret };
}

export function createSpeechPlaybackServer(store) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const tails = new Map();
  async function serialize(key, run) {
    const previous = tails.get(key) ?? Promise.resolve();
    let release; const tail = new Promise(resolve => { release = resolve; });
    tails.set(key, tail);
    await previous;
    try { return await run(); }
    finally { release(); if (tails.get(key) === tail) tails.delete(key); }
  }
  server.on('connection', client => {
    const controller = new AbortController(); let started = false, closed = false, seq = 0, queued = 0, wake;
    const outstanding = new Map();
    const idle = setTimeout(() => client.close(), 15000);
    const close = () => { closed = true; clearTimeout(idle); controller.abort(); wake?.(); };
    client.on('close', close); client.on('error', close);
    const send = value => { if (!closed && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    async function emitAudio(bytes, check) {
      if (closed) return;
      if (!bytes.length) return;
      if (bytes.length % 2) throw new Error('语音服务返回了无效 PCM 数据。');
      if (check) return;
      // Bound playback ahead to about four seconds. ACKs reflect played chunks,
      // not merely received data, so long replies do not fill renderer memory.
      for (let offset = 0; offset < bytes.length; offset += 24000) {
        while (queued >= 96000 && !closed) {
          controller.signal.throwIfAborted();
          await new Promise(resolve => {
            const timeout = setTimeout(() => { controller.abort(); resolve(); }, 30000);
            wake = () => { clearTimeout(timeout); resolve(); };
          });
        }
        if (closed) return;
        controller.signal.throwIfAborted();
        const part = bytes.subarray(offset, offset + 24000), id = ++seq;
        outstanding.set(id, part.length / 2); queued += part.length / 2;
        send({ type: 'audio', id, audio: part.toString('base64'), sampleRate: 24000 });
      }
    }
    async function synthesize(input) {
      const { endpoint, model, secret } = connection(store);
      const apiKey = secret ? await revealSecret(secret) : undefined;
      const check = input.type === 'check';
      const text = check ? '你好。' : input.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 60000) throw new Error('播报文字为空或过长（最多 60000 字符）。');
      await serialize(endpoint.href, async () => {
      for (const part of speechSegments(text)) {
        if (closed) return;
        // The deployed worker may outlive a disconnected HTTP handler. Drain
        // the accepted segment before releasing this endpoint to a new reply.
        // Playback stops immediately; no subsequent old segments are submitted.
        const signal = AbortSignal.timeout(120000);
        let response;
        for (let attempt = 0; ; attempt++) {
          response = await fetch(endpoint, { method: 'POST', signal,
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, input: part, stream: true, response_format: 'pcm' }) });
          if (response.status !== 429 || attempt === 10) break;
          await response.body?.cancel(); await delay(200, undefined, { signal: controller.signal });
          if (closed) return;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`语音合成服务不可用（HTTP ${response.status}）。`); }
        const kind = response.headers.get('content-type') ?? ''; let audioBytes = 0;
        if (kind.includes('ndjson')) {
          let pending = '', done = false; const decoder = new TextDecoder();
          const consume = async line => {
            if (!line.trim()) return;
            const event = JSON.parse(line);
            if (event.event === 'error' || event.event === 'cancelled') throw new Error('语音合成失败，请稍后重试。');
            if (event.event === 'done') done = true;
            if (event.event !== 'chunk') return;
            if (event.sample_rate !== 24000 || typeof event.audio_b64 !== 'string' || event.audio_b64.length > 1400000)
              throw new Error('语音服务需返回 24 kHz 单声道 PCM16 音频。');
            const bytes = Buffer.from(event.audio_b64, 'base64'); audioBytes += bytes.length;
            await emitAudio(bytes, check);
          };
          for await (const chunk of response.body) {
            pending += decoder.decode(chunk, { stream: true });
            if (pending.length > 2 * 1024 * 1024) throw new Error('语音服务响应过大。');
            let n; while ((n = pending.indexOf('\n')) >= 0) { await consume(pending.slice(0, n)); pending = pending.slice(n + 1); }
          }
          pending += decoder.decode(); await consume(pending);
          if (!done) throw new Error('语音合成流提前结束。');
        } else if (/audio\/(?:pcm|raw)|application\/octet-stream/iu.test(kind)) {
          let pending = Buffer.alloc(0);
          for await (const chunk of response.body) {
            pending = Buffer.concat([pending, chunk]); const end = pending.length - pending.length % 2;
            audioBytes += end; await emitAudio(pending.subarray(0, end), check); pending = pending.subarray(end);
          }
          if (pending.length) throw new Error('语音服务返回了截断的 PCM 数据。');
        } else { await response.body?.cancel(); throw new Error('语音服务需支持流式 PCM 或 QwenTTS NDJSON 输出。'); }
        if (!audioBytes) throw new Error('语音合成服务未返回音频。');
      }
      });
      send({ type: 'done' });
    }
    client.on('message', data => {
      try {
        const input = JSON.parse(data.toString());
        if (input.type === 'played' && outstanding.has(input.id)) {
          queued -= outstanding.get(input.id); outstanding.delete(input.id); wake?.(); wake = undefined; return;
        }
        if (started || !['start', 'check'].includes(input.type)) throw new Error('语音播报协议无效。');
        started = true; clearTimeout(idle);
        void synthesize(input).catch(error => {
          const message = error instanceof TypeError ? '无法连接语音合成服务，请检查接口地址与网络。'
            : error?.name === 'TimeoutError' ? '语音合成超时，请稍后重试。'
            : error instanceof SyntaxError ? '语音合成服务响应格式无效。'
            : error instanceof Error ? error.message : '语音播报失败。';
          if (!closed) send({ type: 'error', message }); client.close();
        });
      } catch { send({ type: 'error', message: '语音播报请求无效。' }); client.close(); }
    });
  });
  return server;
}
