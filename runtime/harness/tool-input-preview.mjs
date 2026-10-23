import { PartialArguments } from '@deepseek-ai/dsh-util-values';

// A display view only. It never repairs arguments or supplies tool input.
export function createToolInputPreview() {
  const calls = new Map();
  return {
    push(chunk) {
      if (chunk?.type !== 'tool-call-delta' || !Number.isSafeInteger(chunk.index) || chunk.index < 0 ||
          typeof chunk.id !== 'string' || !chunk.id || typeof chunk.argumentsDelta !== 'string') return;
      let call = calls.get(chunk.index);
      if (!call) calls.set(chunk.index, call = { id: chunk.id, args: new PartialArguments() });
      if (call.id !== chunk.id) return;
      if (typeof chunk.name === 'string' && chunk.name && chunk.name.length <= 256) call.name = chunk.name;
      call.args.append(chunk.argumentsDelta);
    },
    read(index) {
      const call = calls.get(index);
      if (!call?.name) return;
      const result = { id: call.id, name: call.name };
      const name = call.name.split(/__|::/).at(-1);
      if (['read', 'write', 'edit', 'text_editor'].includes(name)) {
        for (const key of ['file_path', 'path']) {
          if (!call.args.complete(key) || call.args.stringExceeds(key, 4096)) continue;
          const path = call.args.text(key);
          if (path) { result.path = path; break; }
        }
      }
      if (['write', 'edit', 'text_editor'].includes(name)) {
        let length = 0, found = false;
        for (const key of ['content', 'old_string', 'new_string']) {
          const size = call.args.stringLength(key, { step: 1024 });
          if (size !== undefined) { length += size; found = true; }
        }
        if (found) result.kilobytes = Math.ceil(length / 1024);
      }
      return result;
    },
    clear() { calls.clear(); },
  };
}
