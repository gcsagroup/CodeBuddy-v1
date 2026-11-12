import { isUtf8 } from 'node:buffer';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';

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
  spawn(spec) {
    const handle = super.spawn(spec);
    if (!spec[shellOutput]) return handle;
    let finished = false;
    const markFinished = () => { finished = true; };
    handle.done.then(markFinished, markFinished);
    return { ...handle, collected: Object.fromEntries(Object.entries(handle.collected)
      .map(([channel, reader]) => [channel, shellReader(reader, () => finished)])) };
  }
}
