'use strict';
const fs = require('node:fs/promises');
const { Writable } = require('node:stream');

// One active file plus one previous file; serialize both child output streams.
function createRotatingLog(file, maxBytes = 10 * 1024 * 1024) {
  let handle, size = 0;
  async function open() {
    if (!handle) {
      handle = await fs.open(file, 'a');
      size = (await handle.stat()).size;
    }
  }
  async function write(chunk) {
    await open();
    let offset = 0;
    while (offset < chunk.length) {
      if (size >= maxBytes) {
        await handle.close(); handle = undefined;
        // Only this logger's previous output is replaced; never touch other logs.
        await fs.rename(file, `${file}.previous`);
        await open();
      }
      const count = Math.min(maxBytes - size, chunk.length - offset);
      let written = 0;
      while (written < count) {
        const result = await handle.write(chunk, offset + written, count - written);
        if (!result.bytesWritten) throw new Error('Log write made no progress');
        written += result.bytesWritten;
      }
      size += written; offset += written;
    }
  }
  return new Writable({
    write(chunk, _encoding, callback) { write(chunk).then(() => callback(), callback); },
    final(callback) {
      const current = handle; handle = undefined;
      (current?.close() ?? Promise.resolve()).then(() => callback(), callback);
    },
    destroy(error, callback) {
      const current = handle; handle = undefined;
      (current?.close() ?? Promise.resolve()).then(() => callback(error), callback);
    },
  });
}
module.exports = { createRotatingLog };
