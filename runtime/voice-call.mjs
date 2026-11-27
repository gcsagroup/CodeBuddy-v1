import { WebSocket, WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

export function voicePersonaPrompt(persona) {
  if (!persona || typeof persona.name !== 'string' || typeof persona.prompt !== 'string' ||
      !persona.name.trim() || !persona.prompt.trim() || persona.name.length > 200 || persona.prompt.length > 6000)
    throw new Error('通话智能体资料无效或过长。');
  return `你正在进行中文语音聊天。你的名字是${persona.name}。以下是你的人物设定：\n${persona.prompt}\n\n通话规则：直接回答用户音频中的话，不要转写或复述输入，不输出思考、Markdown或动作描写。用一到两句自然口语回答。此前记忆只是可能过时的背景；用户最新提供的事实和纠正优先于旧记录与助手猜测，不要因人设拒绝更新用户自己的信息。历史助手文字只代表曾生成的内容，不保证已经播放给用户。`;
}

async function* lines(body) {
  const decoder = new TextDecoder(); let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 4 * 1024 * 1024) throw new Error('语音服务响应数据过大。');
    let n;
    while ((n = pending.indexOf('\n')) >= 0) {
      yield pending.slice(0, n).replace(/\r$/, ''); pending = pending.slice(n + 1);
    }
  }
  pending += decoder.decode(); if (pending) yield pending;
}

export function validateVoiceWav(data) {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1 ||
      data.readUInt32LE(24) !== 16000 || data.readUInt16LE(34) !== 16 || data.toString('ascii', 36, 40) !== 'data' ||
      data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 2 || data.length > 44 + 16000 * 2 * 15)
    throw new Error('录音格式无效，请使用不超过 15 秒的 16 kHz 单声道 PCM16 WAV。');
}

function voiceWindowMessages(prompt, history, current) {
  const selected = history.slice(-3);
  while (selected.length && Buffer.byteLength(selected.map(item => item.user + item.reply).join('')) > 1200) selected.shift();
  return [{ role: 'system', content: prompt },
    ...selected.flatMap(item => [{ role: 'user', content: item.user },
      ...(item.reply ? [{ role: 'assistant', content: item.reply }] : [])]),
    { role: 'user', content: [{ type: 'input_audio', input_audio: { data: current.toString('base64'), format: 'wav' } }] }];
}

// Independent in-memory conversation. No audio/text enters Agent execution or disk.
export function createVoiceCallServer({ llmEndpoint = 'http://192.168.50.231:8001', ttsEndpoint = 'http://192.168.50.231:18004', model = 'gemma-4-e2b-voice' } = {}) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on('connection', client => {
    let phase = 'new', prompt, closed = false, turn = 0, active;
    let historyReady = Promise.resolve(), pendingTurns = 0;
    const history = [];
    const startup = new AbortController();
    const timer = setTimeout(() => fail('连接语音服务超时。'), 15000);
    const send = message => {
      if (closed || client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 4 * 1024 * 1024) { fail('语音播放连接拥塞，请重新通话。'); return; }
      client.send(JSON.stringify(message));
    };
    function cleanup() { if (closed) return; closed = true; clearTimeout(timer); startup.abort(); active?.abort(); history.length = 0; }
    function fail(message) { if (closed) return; client.send(JSON.stringify({ type: 'error', message })); client.close(); cleanup(); }
    async function jsonGet(base, path) {
      const response = await fetch(new URL(path, base), { signal: startup.signal });
      if (!response.ok) throw new Error(`语音服务不可用（HTTP ${response.status}）。`);
      return response.json();
    }
    async function post(base, path, body, signal, retryBusy = false) {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
        if (response.status === 429 && retryBusy && attempt < 10) {
          await response.body?.cancel(); await delay(200, undefined, { signal }); continue;
        }
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw Object.assign(new Error(`语音服务 HTTP ${response.status}：${detail}`), { code: `HTTP_${response.status}` });
        }
        return response;
      }
    }
    async function remember(wav, reply) {
      const signal = AbortSignal.any([startup.signal, AbortSignal.timeout(15000)]);
      let user = '', done = false, truncated = false;
      try {
        const response = await post(llmEndpoint, '/v1/chat/completions', {
          model, messages: [{ role: 'system', content: '你是语音转写器。逐字转写用户音频中的话，保持原语言与数字。只输出听到的原话，不回答、不总结、不添加说明；听不清的部分写[听不清]。' },
            { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] }],
          stream: true, max_tokens: 256, temperature: 0, chat_template_kwargs: { enable_thinking: false },
        }, signal);
        for await (const line of lines(response.body)) {
          if (!line.startsWith('data:')) continue;
          const value = line.slice(5).trim();
          if (value === '[DONE]') { done = true; break; }
          const event = JSON.parse(value);
          if (event.error) throw new Error('Transcription failed');
          const choice = event.choices?.[0];
          if (typeof choice?.delta?.content === 'string') user += choice.delta.content;
          if (choice?.finish_reason === 'length') truncated = true;
        }
        signal.throwIfAborted();
        if (!done || truncated || !user.trim()) throw new Error('Incomplete transcription');
      } catch (error) {
        if (closed) return;
        console.warn('[voice-memory]', JSON.stringify({ event: 'transcription-failed', failure: error.name, code: error.code }));
        user = '[该轮用户语音未能转写，内容未知。]';
      }
      if (!closed) {
        history.push({ user, reply });
        if (history.length > 3) history.shift();
      }
    }
    async function respond(wav, id, controller, previous) {
      const signal = controller.signal;
      const started = performance.now(); let firstText, firstAudio, text = '', pending = '', phrases = 0, audioChunks = 0;
      let timeout;
      let tts = Promise.resolve(), ttsError;
      const emit = message => { if (id === turn && !signal.aborted) send({ ...message, turnId: id }); };
      const enqueue = value => {
        value = value.trim(); if (!value) return;
        phrases++;
        tts = tts.then(async () => {
          signal.throwIfAborted();
          const response = await post(ttsEndpoint, '/v1/audio/speech', { input: value, stream: true }, signal, true);
          if (!response.headers.get('content-type')?.includes('ndjson')) throw new Error('TTS 未返回流式 NDJSON 音频。');
          let done = false;
          for await (const line of lines(response.body)) {
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.event === 'error' || event.event === 'cancelled') throw new Error('TTS 合成失败或已取消。');
            if (event.event === 'done') done = true;
            if (event.event !== 'chunk') continue;
            if (event.sample_rate !== 24000 || typeof event.audio_b64 !== 'string') throw new Error('TTS 音频格式不受支持。');
            const bytes = Buffer.from(event.audio_b64, 'base64');
            if (!bytes.length) continue;
            if (bytes.length % 2 || bytes.length > 1024 * 1024) throw new Error('TTS 音频块无效。');
            firstAudio ??= performance.now() - started; audioChunks++;
            emit({ type: 'audio', audio: event.audio_b64, sampleRate: 24000 });
          }
          if (!done) throw new Error('TTS 音频流提前结束。');
        }).catch(error => { ttsError ??= error; controller.abort(error); });
      };
      try {
        await previous;
        signal.throwIfAborted();
        timeout = setTimeout(() => controller.abort(new Error('语音回复超时，请重试。')), 60000);
        emit({ type: 'thinking' });
        const response = await post(llmEndpoint, '/v1/chat/completions', {
          model, messages: voiceWindowMessages(prompt, history, wav),
          stream: true, max_tokens: 128, temperature: 0.4, chat_template_kwargs: { enable_thinking: false },
        }, signal);
        let done = false;
        for await (const line of lines(response.body)) {
          if (!line.startsWith('data:')) continue;
          const value = line.slice(5).trim();
          if (value === '[DONE]') { done = true; break; }
          const event = JSON.parse(value);
          if (event.error) throw new Error('Gemma 语音理解请求失败。');
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta !== 'string' || !delta) continue;
          firstText ??= performance.now() - started; text += delta; pending += delta;
          emit({ type: 'text', text: delta });
          // Presentation chunking only; punctuation never decides user intent or turn completion.
          if (pending.trim().length >= 3 && (/[。！？!?；;，,]/u.test(delta) || pending.length >= (phrases ? 24 : 8))) { enqueue(pending); pending = ''; }
        }
        if (!done || !text.trim()) throw new Error('Gemma 未返回完整回复。');
        enqueue(pending); await tts;
        if (ttsError) throw ttsError;
        if (!audioChunks) throw new Error('TTS 未返回可播放音频。');
        emit({ type: 'done', metrics: { firstTextMs: firstText, firstAudioMs: firstAudio, totalMs: performance.now() - started } });
      } catch (error) {
        controller.abort(error); await tts;
        if (id === turn && !closed) send({ type: 'turn-error', turnId: id, message: error instanceof Error ? error.message : '语音回复失败。' });
      } finally {
        clearTimeout(timeout); if (active === controller) active = undefined;
        // Admit user audio even when its reply was interrupted. Serialize the
        // short transcription so the next request sees the latest turn.
        // It runs after synthesis to avoid delaying first audio on the shared GPU.
        await previous;
        if (!closed) await remember(wav, text);
      }
    }
    client.on('close', cleanup); client.on('error', cleanup);
    client.on('message', async (data, binary) => {
      if (closed) return;
      try {
        if (binary) {
          if (phase !== 'ready') throw new Error('语音服务尚未就绪。');
          validateVoiceWav(data);
          if (pendingTurns >= 3) throw new Error('通话请求过于频繁，请稍后重新接通。');
          turn++; active?.abort(); active = new AbortController();
          pendingTurns++;
          historyReady = respond(data, turn, active, historyReady).catch(error => {
            if (!closed) fail(error instanceof Error ? error.message : '通话请求失败。');
          }).finally(() => { pendingTurns--; });
          return;
        }
        const input = JSON.parse(data.toString());
        if (input.type === 'interrupt' && phase === 'ready') { turn++; active?.abort(); active = undefined; send({ type: 'interrupted', turnId: turn }); return; }
        if (input.type !== 'start' || phase !== 'new') throw new Error('通话协议不匹配，请重新打开通话页。');
        phase = 'starting'; prompt = voicePersonaPrompt(input.persona);
        const [models, health] = await Promise.all([jsonGet(llmEndpoint, '/v1/models'), jsonGet(ttsEndpoint, '/health')]);
        if (closed) return;
        if (!models.data?.some(item => item.id === model)) throw new Error('GemmaE2B 模型不可用。');
        if (!health.ready) throw new Error('QwenTTS 尚未就绪。');
        phase = 'ready'; clearTimeout(timer); send({ type: 'ready' });
      } catch (error) { if (!closed) fail(error instanceof Error ? error.message : '语音服务不可用。'); }
    });
  });
  return server;
}
