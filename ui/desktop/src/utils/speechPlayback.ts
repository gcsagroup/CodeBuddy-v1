/* global WebSocket, AudioBufferSourceNode, atob */
type PlaybackState = { id: string | null; status: 'idle' | 'loading' | 'playing'; error: string };
const listeners = new Set<() => void>();
let state: PlaybackState = { id: null, status: 'idle', error: '' };
let socket: WebSocket | undefined,
  context: AudioContext | undefined,
  timer: ReturnType<typeof setTimeout>;
let generation = 0,
  playAt = 0,
  done = false;
const sources = new Set<AudioBufferSourceNode>();
function update(next: PlaybackState) {
  if (state.id === next.id && state.status === next.status && state.error === next.error) return;
  state = next;
  listeners.forEach((listener) => listener());
}
async function speechUrl() {
  const endpoint = await window.electron.getAcpUrl();
  if (!endpoint) throw new Error('本地运行时尚未就绪。');
  const url = new URL(endpoint);
  url.pathname = '/speech-playback';
  return url.toString();
}
function cleanup() {
  clearTimeout(timer);
  socket?.close();
  socket = undefined;
  for (const source of sources) {
    source.onended = null;
    source.stop();
    source.disconnect();
  }
  sources.clear();
  void context?.close().catch(() => undefined);
  context = undefined;
}
export const speechPlayback = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot() {
    return state;
  },
  stop(id?: string) {
    if (id && state.id !== id) return;
    generation++;
    cleanup();
    update({ id: null, status: 'idle', error: '' });
  },
  async start(id: string, text: string) {
    this.stop();
    const current = generation;
    update({ id, status: 'loading', error: '' });
    done = false;
    playAt = 0;
    const fail = (message: string) => {
      if (current !== generation) return;
      generation++;
      cleanup();
      update({ id, status: 'idle', error: message });
    };
    try {
      const audio = new AudioContext();
      context = audio;
      await audio.resume();
      const url = await speechUrl();
      if (current !== generation) return;
      const ws = new WebSocket(url);
      socket = ws;
      timer = setTimeout(() => fail('语音合成连接超时，请检查语音服务设置。'), 30000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'start', text }));
      ws.onerror = () => fail('无法连接语音播报服务。');
      ws.onclose = () => {
        if (!done) fail('语音播报连接已断开。');
      };
      const finish = () => {
        if (done && !sources.size && current === generation) this.stop(id);
      };
      ws.onmessage = (event) => {
        if (current !== generation) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'error') {
            fail(message.message);
            return;
          }
          if (message.type === 'done') {
            clearTimeout(timer);
            done = true;
            finish();
            return;
          }
          if (message.type !== 'audio') return;
          clearTimeout(timer);
          if (
            message.sampleRate !== 24000 ||
            typeof message.audio !== 'string' ||
            message.audio.length > 40000
          )
            throw new Error('语音音频格式无效。');
          const bytes = Uint8Array.from(atob(message.audio), (c) => c.charCodeAt(0));
          if (!bytes.length || bytes.length % 2) throw new Error('语音音频数据无效。');
          const view = new DataView(bytes.buffer),
            buffer = audio.createBuffer(1, bytes.length / 2, 24000),
            samples = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.connect(audio.destination);
          sources.add(source);
          source.onended = () => {
            sources.delete(source);
            source.disconnect();
            if (current !== generation) return;
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'played', id: message.id }));
            finish();
          };
          playAt = Math.max(playAt, audio.currentTime + 0.02);
          source.start(playAt);
          playAt += buffer.duration;
          update({ id, status: 'playing', error: '' });
        } catch (error) {
          fail(error instanceof Error ? error.message : '语音播报失败。');
        }
      };
    } catch (error) {
      fail(error instanceof Error ? error.message : '无法启动音频播放。');
    }
  },
};

export async function checkSpeechService() {
  const url = await speechUrl();
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('语音合成连接检测超时。')), 30000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'check' }));
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'done') finish();
        else if (message.type === 'error') finish(new Error(message.message));
      } catch {
        finish(new Error('语音合成服务响应无效。'));
      }
    };
    ws.onerror = ws.onclose = () => finish(new Error('无法连接语音合成服务。'));
  });
}
