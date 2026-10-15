import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { structuredPatch } from 'diff';

if (!isMainThread) parentPort.on('message', ({ oldText, newText }) => {
  const patch = structuredPatch('old', 'new', oldText, newText, '', '', { context: 3 });
  parentPort.postMessage({ diff: patch.hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`).join(''),
    hunks: patch.hunks.map(hunk => ({ oldStart: hunk.oldStart, oldCount: hunk.oldLines, newStart: hunk.newStart, newCount: hunk.newLines })) });
});

// jsdiff 5 is already bundled, but has no synchronous time limit. Isolate it so
// adversarially expensive diffs cannot stall cancellation or the desktop bridge.
export function createReviewDiffer(signal) {
  let worker;
  return {
    async diff(oldText, newText) {
      signal?.throwIfAborted();
      worker ??= new Worker(new URL('./review-diff.mjs', import.meta.url));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(Error('review_diff_timeout')), 2000);
        const done = value => finish(null, value), error = err => finish(err), abort = () => finish(signal.reason ?? Error('review_cancelled'));
        const finish = (err, value) => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          worker.removeListener('message', done); worker.removeListener('error', error);
          err ? reject(err) : resolve(value);
        };
        worker.once('message', done); worker.once('error', error); signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage({ oldText, newText });
      });
    },
    async close() { if (worker) await worker.terminate(); },
  };
}
