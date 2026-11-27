export const VOICE_SAMPLE_RATE = 16000;

export function encodeVoiceWav(chunks: Float32Array[]): ArrayBuffer {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + count * 2),
    view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const value of chunk) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  return buffer;
}

/** Bounded local energy endpointing; manual finish remains available in noisy rooms. */
export class UtteranceCapture {
  private chunks: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private preSamples = 0;
  private samples = 0;
  private audible = 0;
  private quiet = 0;
  private noise = 0.002;
  private speaking = false;
  constructor(
    private onStart: () => void,
    private onEnd: (wav: ArrayBuffer) => void
  ) {}
  reset() {
    this.chunks = [];
    this.preRoll = [];
    this.preSamples = this.samples = this.audible = this.quiet = 0;
    this.speaking = false;
  }
  push(frame: Float32Array) {
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
    const threshold = Math.max(0.008, Math.min(0.03, this.noise * 3));
    if (!this.speaking) {
      this.preRoll.push(frame);
      this.preSamples += frame.length;
      while (this.preSamples > 4800) this.preSamples -= this.preRoll.shift()!.length;
      if (rms >= threshold) this.audible += frame.length;
      else {
        this.audible = 0;
        this.noise = this.noise * 0.98 + rms * 0.02;
      }
      if (this.audible >= 2560) {
        this.speaking = true;
        this.chunks = this.preRoll;
        this.samples = this.preSamples;
        this.preRoll = [];
        this.preSamples = 0;
        this.onStart();
      }
    } else {
      this.chunks.push(frame);
      this.samples += frame.length;
      this.quiet = rms < threshold * 0.7 ? this.quiet + frame.length : 0;
      if (this.quiet >= 10400 || this.samples >= 224000) this.finish();
    }
    return rms;
  }
  finish() {
    if (!this.speaking) return;
    const wav = encodeVoiceWav(this.chunks);
    this.reset();
    this.onEnd(wav);
  }
}
