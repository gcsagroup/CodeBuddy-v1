import { setImmediate as yieldToTransport } from 'node:timers/promises';

// Only resource cleanup is retried. Accepted deletion remains authoritative;
// an unavailable MCP process cannot put the conversation back in the UI.
export class SessionDeletionCleanup {
  constructor(store, cleanup, { retryMs = 1000, onError = (id, error) =>
    console.warn('[Session deletion cleanup]', JSON.stringify({ sessionId: id, error: String(error.message ?? error) })) } = {}) {
    this.store = store;
    this.cleanup = cleanup;
    this.retryMs = retryMs;
    this.onError = onError;
    this.jobs = new Map();
    this.closed = false;
  }
  resume() {
    for (const record of this.store.pendingSessionDeletions?.() ?? []) this.enqueue(record);
  }
  enqueue(record, attempt = 0) {
    if (this.closed || this.jobs.has(record.id)) return;
    const job = {};
    this.jobs.set(record.id, job);
    job.promise = (async () => {
      await yieldToTransport();
      if (this.closed) return;
      try {
        await this.cleanup(record);
        await this.store.finishSessionDeletion(record.id);
      } catch (error) {
        this.onError(record.id, error);
        if (!this.closed) {
          job.timer = setTimeout(() => {
            this.jobs.delete(record.id);
            this.enqueue(record, attempt + 1);
          }, Math.min(this.retryMs * 2 ** Math.min(attempt, 6), 60000));
          job.timer.unref?.();
        }
      } finally {
        if (!job.timer) this.jobs.delete(record.id);
      }
    })();
  }
  async settle(id) { await this.jobs.get(id)?.promise; }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    await Promise.all([...this.jobs.values()].map(job => job.promise));
    this.jobs.clear();
  }
}
