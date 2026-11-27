/* global WebSocket, AudioBufferSourceNode, MediaStreamAudioSourceNode, performance, atob */
import { UtteranceCapture, VOICE_SAMPLE_RATE } from './utterance';

export interface CallEvents {
  status(text: string): void;
  ready(): void;
  level(value: number): void;
  text(value: string): void;
  replyStart?(): void;
  ended(error?: string): void;
}

export class VoiceCall {
  private stopped = false;
  private ready = false;
  private stream?: MediaStream;
  private context?: AudioContext;
  private worklet?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private sources = new Set<AudioBufferSourceNode>();
  private muted = false;
  private turn = 0;
  private playAt = 0;
  private replyDone = false;
  private lastMeter = 0;
  private utterance = new UtteranceCapture(
    () => this.interrupt(),
    (wav) => this.submit(wav)
  );
  constructor(private events: CallEvents) {}
  mute(value: boolean) {
    this.muted = value;
    this.utterance.reset();
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !value;
    });
    if (value) this.events.level(0);
  }
  finishUtterance() {
    this.utterance.finish();
  }
  private interrupt() {
    if (!this.ready || this.stopped) return;
    this.turn++;
    this.stopPlayback();
    this.socket?.send(JSON.stringify({ type: 'interrupt' }));
    this.events.status('正在听你说话…');
  }
  private submit(wav: ArrayBuffer) {
    if (!this.ready || this.stopped || this.muted) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return this.stop('语音连接已断开。');
    this.turn++;
    this.replyDone = false;
    this.events.replyStart?.();
    this.events.status('正在理解你的话…');
    this.socket.send(wav);
  }
  async start(persona: { name: string; prompt: string }) {
    try {
      this.events.status('正在开启麦克风…');
      this.timer = setTimeout(() => this.stop('开启麦克风超时，请检查系统麦克风权限。'), 10000);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      clearTimeout(this.timer);
      stream
        .getAudioTracks()
        .forEach((track) => track.addEventListener('ended', () => this.stop('麦克风已断开。')));
      this.timer = setTimeout(() => this.stop('连接语音服务超时。'), 20000);
      const context = (this.context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE }));
      await context.resume();
      await context.audioWorklet.addModule(
        new URL('audio-capture-worklet.js', window.location.href.split('#')[0]).href
      );
      if (this.stopped) return;
      const worklet = (this.worklet = new AudioWorkletNode(context, 'audio-capture'));
      const source = (this.source = context.createMediaStreamSource(stream));
      source.connect(worklet);
      worklet.connect(context.destination);
      worklet.port.onmessage = (event) => {
        if (!this.ready || this.stopped || this.muted) return;
        const rms = this.utterance.push(event.data as Float32Array);
        if (performance.now() - this.lastMeter >= 60) {
          this.lastMeter = performance.now();
          this.events.level(rms);
        }
      };
      const raw = await window.electron.getAcpUrl();
      if (this.stopped) return;
      if (!raw) throw new Error('本地通话服务不可用。');
      const url = new URL(raw);
      url.pathname = url.pathname.replace(/\/acp$/, '/voice-call');
      const socket = (this.socket = new WebSocket(url));
      this.events.status('正在连接 GemmaE2B 和 QwenTTS…');
      socket.onopen = () => socket.send(JSON.stringify({ type: 'start', persona }));
      socket.onerror = () => this.stop('无法连接本地语音服务。');
      socket.onclose = () => this.stop('通话连接已断开。');
      socket.onmessage = (event) => {
        if (this.stopped) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'error') {
            this.stop(message.message);
            return;
          }
          if (message.type === 'ready') {
            this.ready = true;
            clearTimeout(this.timer);
            this.events.ready();
            this.events.status('请说话，停顿后自动回复');
            return;
          }
          if (message.turnId !== this.turn) return;
          if (message.type === 'thinking') this.events.status('正在理解你的话…');
          else if (message.type === 'text') this.events.text(message.text);
          else if (message.type === 'audio') this.play(message.audio, message.sampleRate);
          else if (message.type === 'done') {
            this.replyDone = true;
            if (!this.sources.size) this.events.status('请继续说话');
          } else if (message.type === 'turn-error') {
            this.stopPlayback();
            this.events.status(`本次回复失败：${message.message} 请重说。`);
          }
        } catch (error) {
          this.stop(error instanceof Error ? error.message : '语音数据无效。');
        }
      };
    } catch (error) {
      this.stop(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在系统设置中允许访问。'
          : error instanceof Error
            ? error.message
            : '无法开启语音通话。'
      );
    }
  }
  private play(encoded: string, rate: number) {
    const context = this.context;
    if (!context || rate !== 24000 || typeof encoded !== 'string')
      throw new Error('TTS 音频格式无效。');
    const raw = atob(encoded);
    if (raw.length % 2 || raw.length > 1024 * 1024) throw new Error('TTS 音频块无效。');
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, bytes.length / 2, rate),
      samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    if (this.playAt - context.currentTime > 30) throw new Error('回复音频积压，请重新通话。');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.sources.add(source);
    const turn = this.turn;
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (!this.stopped && turn === this.turn && this.replyDone && !this.sources.size)
        this.events.status('请继续说话');
    };
    this.playAt = Math.max(this.playAt, context.currentTime + 0.03);
    source.start(this.playAt);
    this.playAt += buffer.duration;
    this.events.status('对方正在说话…');
  }
  private stopPlayback() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.playAt = 0;
  }
  stop(error?: string) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.utterance.reset();
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stopPlayback();
    this.socket?.close();
    void this.context?.close().catch(() => {});
    this.events.ended(error);
  }
}
