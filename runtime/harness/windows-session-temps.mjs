import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownSandboxHelper } from './windows-sandbox-job.mjs';

// Session resources outlive recyclable workspace preparation. This owner does
// not execute commands or infer their completion from tool results.
export class WindowsSessionTemps {
  constructor() {
    this.capabilities = new Map(); this.pending = new Map(); this.sequence = 0;
    this.processOwners = new Set(); this.internals = {};
  }
  get resourceTimeoutMs() { return this.internals.resourceTimeoutMs ?? 120000; }
  key(policy) { return JSON.stringify([String(policy.sessionId), resolve(policy.workspaceRoot).toLowerCase()]); }
  invalidate(policy) { this.capabilities.delete(this.key(policy)); }
  registerProcessOwner(owner) {
    this.hasProcessOwner = true;
    this.processOwners.add(owner);
    // A replacement created during Host shutdown must be sealed before its
    // constructor returns, not admitted after a prior owner's drain snapshot.
    if (this.processAdmissionClosed) void owner.quiesce().catch(() => {});
  }
  processOwnerDrained(owner) { this.processOwners.delete(owner); }
  async quiesceProcesses() {
    this.processAdmissionClosed = true;
    while (this.processOwners.size) await Promise.all([...this.processOwners].map(owner => owner.quiesce()));
  }
  settle(request, error, value) {
    clearTimeout(request.watchdog);
    this.pending.delete(request.id);
    if (error) {
      if (this.capabilities.get(request.key) === request) this.capabilities.delete(request.key);
    } else request.value = value;
    for (const waiter of [...request.waiters]) waiter.finish(error, value);
  }
  fail(worker, error) {
    if (this.worker === worker) { this.worker = undefined; this.capabilities.clear(); }
    for (const request of [...this.pending.values()]) if (request.worker === worker) this.settle(request, error);
  }
  retire(worker, error) {
    if (worker.retiring) return;
    worker.retiring = true;
    // Errors and kill requests do not confirm physical exit. Keep admission
    // sealed until this exact child's close event, including failed Job setup.
    if (this.worker === worker) this.retiring = worker;
    this.fail(worker, error);
    if (worker.releaseJob) worker.releaseJob();
    else worker.child.kill();
  }
  start() {
    if (this.retiring) throw Error('The previous TEMP resource owner has not exited; new authorization was not queued.');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./windows-session-temps-process.mjs', import.meta.url))],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exit = Promise.withResolvers();
    const worker = { child, closed: exit.promise };
    let diagnostic = '';
    // Node may emit spawn errors before it creates any stdio handles.
    child.stderr?.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    this.worker = worker;
    child.on('error', error => this.retire(worker, error));
    child.on('close', () => {
      worker.releaseJob?.();
      this.fail(worker, new Error('Session TEMP resource process exited; new calls require fresh private grants. ' + diagnostic.trim()));
      if (this.retiring === worker) this.retiring = undefined;
      exit.resolve();
    });
    child.on('message', message => {
      if (message.cleanupFailures) console.warn('[Windows session TEMP]', JSON.stringify({ cleanupFailures: message.cleanupFailures }));
      const request = this.pending.get(message.id);
      if (!request || request.worker !== worker) return;
      if (performance.now() >= request.deadlineAt) { this.expireOwner(worker); return; }
      const value = message.value;
      const error = message.error ? Error(message.error)
        : !value || value.sessionId !== String(request.policy.sessionId) ||
          !['workspaceRoot', 'dir', 'writeSid'].every(name => typeof value[name] === 'string' && value[name])
          ? Error('Invalid session TEMP capability receipt') : undefined;
      this.settle(request, error, value);
    });
    try {
      if (!child.pid) throw Error('Session TEMP resource process did not start');
      worker.releaseJob = ownSandboxHelper(child.pid);
    } catch (error) { this.retire(worker, error); throw error; }
    return worker;
  }
  expireOwner(worker) {
    if (this.worker !== worker) return;
    // Hard exit skips revoke/delete: old commands may still run.
    this.retire(worker, Error('Session TEMP resource operation deadline expired; old private grants were retained.'));
  }
  allocation(policy) {
    const key = this.key(policy);
    if (this.capabilities.has(key)) return this.capabilities.get(key);
    if (this.pending.size >= 16) throw Error('Session TEMP authorization is busy; no new request was queued.');
    const worker = this.worker ?? this.start(), id = ++this.sequence;
    const deadlineAt = performance.now() + this.resourceTimeoutMs;
    const request = { id, key, worker, policy, deadlineAt, waiters: new Set() };
    request.watchdog = setTimeout(() => this.expireOwner(worker), Math.max(1, deadlineAt - performance.now()));
    this.pending.set(id, request); this.capabilities.set(key, request);
    worker.child.send({ type: 'acquire', id, policy: { sessionId: policy.sessionId, workspaceRoot: policy.workspaceRoot } }, error => {
      if (error && this.pending.get(id) === request) this.retire(worker, error);
    });
    return request;
  }
  async acquire(policy, signal, deadlineAt) {
    signal?.throwIfAborted();
    if (this.closing || this.processAdmissionClosed) throw Error('Session TEMP resource owner is closing');
    if (performance.now() >= deadlineAt) throw Error('Session TEMP authorization deadline expired.');
    const request = this.allocation(policy);
    if (request.value) return request.value;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        request.waiters.delete(waiter);
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const waiter = { finish };
      const abort = () => finish(signal.reason ?? new DOMException('Session TEMP wait cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(Error('Session TEMP authorization deadline expired.')), Math.max(1, deadlineAt - performance.now()));
      request.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  close(cleanup = true) {
    if (this.closing) return this.closing;
    this.closing = this.closeWorker(cleanup);
    return this.closing;
  }
  async closeWorker(cleanup) {
    const worker = this.worker ?? this.retiring;
    if (!worker) return;
    const dispose = cleanup && this.worker === worker;
    // Revoking grants and removing every owned directory can take time even
    // after all consumers exited. Give it the normal resource-operation bound.
    const timeoutMs = dispose ? this.resourceTimeoutMs : 2500;
    for (const request of [...this.pending.values()]) this.settle(request, Error('Session TEMP owner closed before authorization completed.'));
    let timer;
    try {
      if (worker.child.connected) worker.child.send({ type: dispose ? 'dispose' : 'abandon' }, () => {});
      await Promise.race([worker.closed, new Promise(resolve => {
        timer = setTimeout(() => {
          console.warn('[Windows session TEMP]', JSON.stringify({ status: 'cleanup-exit-unconfirmed', cleanupRequested: dispose, timeoutMs }));
          worker.releaseJob?.(); resolve();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}
