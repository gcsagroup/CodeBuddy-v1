import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';

if (process.platform === 'win32' && createHash('sha256')
  .update(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-subprocess-local')))).digest('hex') !==
  '20c29aded30123bb9b4ec5cf9df64bf3f2f26fb60cd6f48ad67b31b6e56c5ce3')
  throw Error('Review the pinned subprocess admission and shutdown contract.');

export const shellOutput = Symbol('CodeBuddy Windows shell output');
const gbk = new TextDecoder('gbk', { fatal: true, ignoreBOM: true });

function decodeFragment(bytes) {
  if (isUtf8(bytes)) return bytes.toString('utf8');
  try { return gbk.decode(bytes); }
  catch { return bytes.toString('utf8'); }
}

// The native reader owns truncation, spill files and byte offsets. Its pinned
// local collector also exposes the raw tail before irreversible UTF-8 decoding.
export function shellReader(reader, settled) {
  return { readFrom(offset) {
    const read = reader.readFrom(offset);
    if (!read.text.includes('\uFFFD')) return read;
    const { bytes, totalBytes } = reader.snapshot();
    const tail = bytes.subarray(Math.max(0, offset - (totalBytes - bytes.length)));
    // During a live read the final legacy/invalid line may end mid-character.
    // Leave it for the next poll, which uses the same raw byte coordinates.
    const end = settled() ? tail.length : tail.lastIndexOf(10) + 1;
    const parts = [];
    let start = 0;
    while (start < end) {
      // ASCII below 0x40 cannot be part of any GBK or UTF-8 multibyte
      // character. A path separator or space can separate differently
      // encoded fields even on the same line.
      let stop = start;
      while (stop < end && tail[stop] >= 0x40) stop++;
      if (stop > start) parts.push(decodeFragment(tail.subarray(start, stop)));
      start = stop;
      while (stop < end && tail[stop] < 0x40) stop++;
      if (stop > start) parts.push(tail.toString('ascii', start, stop));
      start = stop;
    }
    return { ...read, text: parts.join(''), nextOffset: totalBytes - tail.length + end };
  } };
}

export default class WindowsSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx) {
    super(ctx);
    this.allocationStop = new AbortController();
    this.terminalAllocations = new Set();
    this.sessionResources = ctx.get('codebuddyWindowsSessionTemps');
    this.sessionResources?.registerProcessOwner(this);
  }

  quiesce() { return this.disposeManagedProcesses(); }

  disposeManagedProcesses() {
    if (this.draining) return this.draining;
    // The native disposer is called concurrently by Cordis. Seal admission in
    // this same stack, before its live-range snapshot, and share one barrier.
    this.closing = true;
    this.allocationStop.abort();
    this.draining = Promise.allSettled([...this.terminalAllocations])
      .then(() => super.disposeManagedProcesses())
      .then(() => { this.sessionResources?.processOwnerDrained(this); });
    return this.draining;
  }

  async spawnTerminal(spec) {
    if (this.closing) throw Error('Windows subprocess owner is closing; terminal was not started.');
    const pending = super.spawnTerminal({ ...spec, signal: spec.signal
      ? AbortSignal.any([spec.signal, this.allocationStop.signal]) : this.allocationStop.signal });
    this.terminalAllocations.add(pending);
    try {
      const terminal = await pending;
      if (this.closing) { await terminal.terminate(); throw Error('Windows subprocess owner closed during terminal allocation.'); }
      return terminal;
    } finally { this.terminalAllocations.delete(pending); }
  }

  spawn(spec) {
    if (this.closing) throw Error('Windows subprocess owner is closing; command was not started.');
    const handle = super.spawn(spec);
    if (!spec[shellOutput]) return handle;
    let finished = false;
    const markFinished = () => { finished = true; };
    handle.done.then(markFinished, markFinished);
    return { ...handle, collected: Object.fromEntries(Object.entries(handle.collected)
      .map(([channel, reader]) => [channel, shellReader(reader, () => finished)])) };
  }
}
