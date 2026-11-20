import { createHash } from 'node:crypto';

// openai-node #3050: cancelling at [DONE] discards reusable HTTP connections.
// Keep the SDK's sentinel parser and early-abort owner; only completed-body
// cleanup becomes bounded background work. Remove after an upstream fix.
export const streamCompletionPatch = {
  name: 'openai/core/streaming',
  hash: '1b8fa8338dc28913351993382187962082f0af42c5274a009060de3263579842',
  transform(source) {
    if (createHash('sha256').update(source).digest('hex') !== this.hash)
      throw new Error('Review the locked OpenAI stream completion compatibility patch.');
    const replace = (before, after) => {
      if (source.split(before).length !== 2) throw new Error('OpenAI stream cleanup boundary changed.');
      source = source.replace(before, after);
    };
    replace('                        receivedCompletionSentinel = true;',
      '                        receivedCompletionSentinel = true;\n                        codebuddyStreamTiming.publish({ phase: "completion_sentinel" });');
    replace('const messages = _iterSSEMessages(response, controller);',
      'const messages = _iterSSEMessages(response, controller, () => receivedCompletionSentinel);');
    replace('function createAbortableSSESource(body, signal) {',
      'function createAbortableSSESource(body, signal, completed) {');
    replace('export async function* _iterSSEMessages(response, controller) {',
      'export async function* _iterSSEMessages(response, controller, completed) {');
    replace('const source = createAbortableSSESource(response.body, signal);',
      'const source = createAbortableSSESource(response.body, signal, completed);');
    replace('        async return() {\n            const pending = cancel();',
      '        async return() {\n            if (completed?.() && !signal.aborted) return ended;\n            const pending = cancel();');
    replace('        async cleanup(failed) {\n            let cleanupError;', `        async cleanup(failed) {
            if (completed?.() && !failed && !signal.aborted && !closed && !canceled) {
                // No SSE parsing or output is allowed after the authoritative sentinel.
                // Bound both the read lifetime and retained work, without delaying tools.
                void (async () => {
                    let timer;
                    const timeout = new Promise(resolve => {
                        timer = setTimeout(() => { cancel(); resolve(ended); }, 1000);
                        timer.unref?.();
                    });
                    let bytes = 0;
                    try {
                        while (!signal.aborted && !canceled && bytes < 65536) {
                            const result = await Promise.race([iterator.next(), timeout]);
                            if (result.done) break;
                            bytes += result.value?.byteLength ?? 65536;
                        }
                    } catch { /* Completion already succeeded; cleanup cannot replace it. */ }
                    finally {
                        clearTimeout(timer);
                        signal.removeEventListener('abort', abort);
                        if (!closed) cancel();
                        try { reader?.releaseLock(); } catch { /* No caller owns this reader. */ }
                    }
                })();
                return;
            }
            let cleanupError;`);
    return 'import { channel as codebuddyDiagnosticChannel } from "node:diagnostics_channel";\nconst codebuddyStreamTiming = codebuddyDiagnosticChannel("codebuddy:provider-stream");\n' + source;
  },
};
