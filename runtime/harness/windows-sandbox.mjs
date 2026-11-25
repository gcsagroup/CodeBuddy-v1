import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';
import { extendWin32ProcessBindings, isNullPtr, throwLastError } from '@deepseek-ai/dsh-win32-process';

function ownPreparationProcess(pid) {
  const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
  }));
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW');
  let processHandle;
  try {
    // Same x64 JOB_OBJECT_EXTENDED_LIMIT_INFORMATION layout and kill-on-close
    // contract as the pinned native process owner. No ACL work starts before IPC.
    const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
    if (!api.setInformationJobObject(job, 9, limits, limits.length)) throwLastError(api, 'SetInformationJobObject');
    processHandle = api.openProcess(0x101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess');
    if (!api.assignProcessToJobObject(job, processHandle)) throwLastError(api, 'AssignProcessToJobObject');
  } catch (error) { api.closeHandle(job); throw error; }
  finally { if (!isNullPtr(processHandle)) api.closeHandle(processHandle); }
  let closed = false;
  return () => { if (!closed) { closed = true; api.closeHandle(job); } };
}

// The native provider owns grants, SIDs, locks and restricted runner argv.
// Its synchronous Win32 ACL propagation can walk millions of descendants.
// Offload it by workspace: one native stall must not block the control plane
// or a different project's shell. Jobs own the entire preparation process tree.
// https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
export default class WindowsSandboxProvider extends LocalSandboxProvider {
  constructor(ctx, config) {
    super(ctx, config);
    this.nativeConfig = config;
    this.workers = new Map();
    this.retiring = new Set();
    this.sequence = 0;
    this.workerSequence = 0;
    ctx.effect(() => () => this.closePreparation());
  }

  workerKey(workspaceRoot, mode) { return resolve(workspaceRoot).toLowerCase() + '\0' + mode; }

  noteFileMutation(path) {
    for (const worker of this.workers.values()) {
      if (worker.mode !== 'workspace-write') continue;
      const inside = relative(worker.root, resolve(path));
      if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) continue;
      // IPC preserves order with the following confine. A lost invalidation
      // retires the cache instead of letting a host write race the observer.
      worker.child.send({ type: 'file-mutation', path }, error => {
        if (error) this.retire(worker, 'invalidation-failure');
      });
    }
  }

  async acquireHelper(policy, signal, deadline) {
    const key = this.workerKey(policy.workspaceRoot, policy.mode);
    if (!this.workers.has(key) && this.workers.size + this.retiring.size >= 4) {
      const idle = [...this.workers.values()].find(worker => !worker.active);
      if (idle) {
        this.retire(idle, 'idle');
        await Promise.race([idle.closed, delay(Math.max(1, Math.min(2100, deadline - Date.now())), undefined, { signal })]);
      }
    }
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Preparation deadline expired while waiting for a process slot.');
    return this.helper(policy.workspaceRoot, policy.mode);
  }

  helper(workspaceRoot = process.cwd(), mode = 'read-only') {
    if (this.closed) throw new Error('Windows sandbox provider is closed');
    const key = this.workerKey(workspaceRoot, mode);
    const existing = this.workers.get(key);
    if (existing) return existing;
    // Bound native processes and queued work. Evict only idle providers; active
    // commands are launched by Harness, outside these preparation Jobs.
    if (this.workers.size + this.retiring.size >= 4) {
      throw new Error('Windows sandbox preparation is busy. Retry after another preparation finishes.');
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./windows-sandbox-process.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const completion = Promise.withResolvers();
    const worker = { id: ++this.workerSequence, key, root: resolve(workspaceRoot), mode, child, queue: [], phase: 'startup', closed: completion.promise };
    this.workers.set(key, worker);
    child.on('error', () => this.retire(worker, 'process-error'));
    child.on('close', () => {
      worker.exited = true;
      worker.releaseJob?.();
      this.retire(worker, 'process-exit');
      clearTimeout(worker.forceTimer);
      this.retiring.delete(worker);
      completion.resolve();
    });
    child.on('message', message => {
      const entry = worker.active;
      if (worker.retiring || !entry || entry.id !== message.id) return;
      if (message.phase) {
        worker.phase = message.phase;
        this.log(worker, entry, 'phase');
        return;
      }
      if (message.error) {
        if (message.error.code === 'CODEBUDDY_WORKSPACE_CHANGED') {
          worker.active = undefined;
          this.retire(worker, 'workspace-replaced');
        }
        entry.finish(this.preparationError(entry, worker.phase, message.error.message));
      } else entry.finish(null, message.result);
    });
    try {
      if (!child.pid) throw new Error('Preparation process did not start');
      worker.releaseJob = ownPreparationProcess(child.pid);
    } catch (error) { this.retire(worker, 'process-start'); child.kill(); throw error; }
    return worker;
  }

  preparationError(entry, phase, detail) {
    const detailText = `Windows sandbox preparation failed during ${phase} after ${Math.round(performance.now() - entry.started)}ms. ` +
      `The user command was not started. ${detail} ` +
      'Use file-reading tools or a read-only operation to continue. The sandbox mode was not widened; preparation may have updated workspace permissions.';
    const error = new SandboxUnavailableError(entry.mode, detailText);
    error.message = detailText;
    return error;
  }

  log(worker, entry, status) {
    // The desktop captures stderr in its rotating runtime.log. Keep stdout
    // available to callers using it as a JSON or stdio protocol channel.
    console.error('[Windows sandbox preparation]', JSON.stringify({ worker: worker.id,
      request: entry.id, phase: worker.phase, status, elapsedMs: Math.round(performance.now() - entry.started) }));
  }

  dispatch(worker) {
    if (worker.retiring || worker.active) return;
    const entry = worker.queue.shift();
    if (!entry) return;
    worker.active = entry;
    worker.phase = 'startup';
    this.log(worker, entry, 'started');
    worker.child.send({ type: 'confine', id: entry.id, argv: entry.argv, policy: entry.policy,
      config: this.nativeConfig, deadline: entry.deadline }, error => {
      if (error) this.retire(worker, 'ipc-failure');
    });
  }

  retire(worker, reason) {
    if (worker.retiring) return;
    worker.retiring = true;
    if (this.workers.get(worker.key) === worker) this.workers.delete(worker.key);
    this.retiring.add(worker);
    for (const entry of [worker.active, ...worker.queue].filter(Boolean))
      entry.finish(this.preparationError(entry, worker.phase, `Preparation process retired (${reason}).`));
    if (worker.exited) return;
    // Let the label helper finish restoring the current object's temporary
    // DACL first. The Job is the final bound for an unresponsive native call.
    worker.forceTimer = setTimeout(() => worker.releaseJob?.(), 2000);
    if (worker.child.connected) worker.child.send({ type: 'dispose' }, () => {});
    else worker.releaseJob?.();
  }

  async confine(argv, policy, signal) {
    signal?.throwIfAborted();
    const started = performance.now();
    // Harness already includes preparation in the caller's tool deadline. Its
    // shorter signal wins; a separate cap also bounds callers without one.
    // Do not truncate normal first-time provisioning at 30s on large projects.
    const timeoutMs = this.internals.preparationTimeoutMs ?? 120000;
    const deadline = Date.now() + timeoutMs;
    const details = { mode: policy.mode, started };
    let worker;
    try { worker = await this.acquireHelper(policy, signal, deadline); }
    catch (error) { signal?.throwIfAborted(); throw this.preparationError(details, 'startup', error.message); }
    if (worker.retiring || this.closed) throw this.preparationError(details, 'startup', 'Preparation process closed before dispatch.');
    if (worker.queue.length >= 16) throw this.preparationError(details, 'queue', 'Preparation queue is full.');
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = { ...details, id: ++this.sequence, argv, policy, deadline };
      const finish = entry.finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearInterval(heartbeat);
        signal?.removeEventListener('abort', abort);
        worker.queue = worker.queue.filter(item => item !== entry);
        if (worker.active === entry) worker.active = undefined;
        this.log(worker, entry, error ? 'failed' : 'ready');
        error ? reject(error) : resolve(result);
        this.dispatch(worker);
      };
      const abort = () => {
        const active = worker.active === entry;
        if (active) { worker.active = undefined; this.retire(worker, 'cancelled'); }
        finish(signal.reason ?? new DOMException('Sandbox preparation cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        const error = this.preparationError(entry, worker.active === entry ? worker.phase : 'queue',
          `The ${timeoutMs}ms preparation deadline expired.`);
        if (worker.active === entry) {
          // Seal the worker before settling: late argv must never start a command.
          worker.queue = worker.queue.filter(item => item !== entry);
          worker.active = undefined;
          this.retire(worker, 'deadline');
        }
        finish(error);
      }, Math.max(1, deadline - Date.now()));
      const heartbeat = setInterval(() => this.log(worker, entry, worker.active === entry ? 'waiting' : 'queued'), 5000);
      signal?.addEventListener('abort', abort, { once: true });
      worker.queue.push(entry);
      if (signal?.aborted) abort();
      else this.dispatch(worker);
    });
  }

  async closePreparation() {
    this.closed = true;
    for (const worker of this.workers.values()) this.retire(worker, 'provider-closed');
    let timer;
    try {
      // Even OS teardown must not hold the embedded Host's shutdown forever.
      await Promise.race([Promise.all([...this.retiring].map(worker => worker.closed)),
        new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
    } finally { clearTimeout(timer); }
    if (this.retiring.size) console.warn('[Windows sandbox preparation]', JSON.stringify({
      status: 'cleanup-exit-unconfirmed', workers: this.retiring.size }));
  }
}
