import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';
import { ownSandboxHelper } from './windows-sandbox-job.mjs';
import { WindowsSessionTemps } from './windows-session-temps.mjs';
import { pwshCodec, windowsPwshCodec } from './windows-pwsh-codec.mjs';

// The native provider owns grants, SIDs, locks and restricted runner argv.
// Its synchronous Win32 ACL propagation can walk millions of descendants.
// Offload it by workspace: one native stall must not block the control plane
// or a different project's shell. Jobs own the entire preparation process tree.
// https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
export default class WindowsSandboxProvider extends LocalSandboxProvider {
  get [windowsPwshCodec]() { return process.platform === 'win32' && !this.nativeConfig.runnerCommand?.length; }

  constructor(ctx, config) {
    super(ctx, config);
    this.nativeConfig = config;
    this.slots = new Map();
    this.sequence = 0;
    this.workerSequence = 0;
    const sharedTemps = ctx.get('codebuddyWindowsSessionTemps');
    this.sessionTemps = sharedTemps ?? new WindowsSessionTemps();
    ctx.effect(() => async () => {
      await this.closePreparation();
      // In a Host this is owned above plugin reloads and is released only
      // after the actual subprocess owner's shutdown barrier.
      if (!sharedTemps) await this.sessionTemps.close();
    });
  }

  workerKey(workspaceRoot, mode) { return resolve(workspaceRoot).toLowerCase() + '\0' + mode; }

  slotFor(policy) {
    if (this.closed) throw new Error('Windows sandbox provider is closed');
    const key = this.workerKey(policy.workspaceRoot, policy.mode);
    let slot = this.slots.get(key);
    if (slot) return slot;
    if (this.slots.size < 4) slot = { queue: [] };
    else {
      slot = [...this.slots.values()].find(candidate => !candidate.queue.length && !candidate.worker?.active);
      if (!slot) throw new Error('Windows sandbox preparation is busy. Retry after another preparation finishes.');
      this.slots.delete(slot.key);
      if (slot.worker) this.retire(slot.worker, 'idle');
    }
    Object.assign(slot, { key, root: resolve(policy.workspaceRoot), mode: policy.mode });
    this.slots.set(key, slot);
    return slot;
  }

  startWorker(slot) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./windows-sandbox-process.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const completion = Promise.withResolvers();
    const worker = { id: ++this.workerSequence, child, phase: 'startup', closed: completion.promise };
    slot.worker = worker;
    child.on('error', () => this.retire(worker, 'process-error'));
    child.on('close', () => {
      worker.exited = true;
      worker.releaseJob?.();
      this.retire(worker, 'process-exit');
      clearTimeout(worker.forceTimer);
      completion.resolve();
      // The slot owns its FIFO across process generations. Only its old
      // child's close event can release the physical process allowance.
      slot.worker = undefined;
      if (slot.queue.length) this.dispatch(slot);
      else this.slots.delete(slot.key);
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
          this.sessionTemps.invalidate(entry.policy);
          this.retire(worker, 'workspace-replaced', this.preparationError(entry, worker.phase, message.error.message));
          // Requests admitted before replacement referred to the old root.
          for (const queued of [...slot.queue]) queued.finish(this.preparationError(queued, 'queue', message.error.message));
          return;
        }
        entry.finish(this.preparationError(entry, worker.phase, message.error.message));
      } else entry.finish(null, message.result);
    });
    try {
      if (!child.pid) throw new Error('Preparation process did not start');
      worker.releaseJob = ownSandboxHelper(child.pid);
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
    console.error('[Windows sandbox preparation]', JSON.stringify({ worker: worker?.id,
      request: entry.id, phase: worker?.phase ?? 'queue', status, elapsedMs: Math.round(performance.now() - entry.started) }));
  }

  dispatch(slot) {
    if (this.closed || slot.worker?.retiring || slot.worker?.active) return;
    const entry = slot.queue[0];
    if (!entry) return;
    if (performance.now() >= entry.deadlineAt) { entry.expire(); return; }
    let worker;
    try { worker = slot.worker ?? this.startWorker(slot); }
    catch (error) { entry.finish(this.preparationError(entry, 'startup', error.message)); return; }
    slot.queue.shift();
    worker.active = entry;
    worker.phase = 'startup';
    this.log(worker, entry, 'started');
    void this.prepareInvocation(worker, entry);
  }

  async prepareInvocation(worker, entry) {
    try {
      let tempCapability;
      if (entry.policy.mode === 'workspace-write' && entry.policy.sessionId !== undefined && !this.nativeConfig.runnerCommand?.length) {
        worker.phase = 'session-temp';
        tempCapability = await this.sessionTemps.acquire(entry.policy, entry.signal, entry.deadlineAt);
      }
      if (worker.retiring || worker.active !== entry) return;
      if (performance.now() >= entry.deadlineAt) { entry.expire(); return; }
      worker.child.send({ type: 'confine', id: entry.id, argv: entry.argv, pwshCodec: entry.argv[pwshCodec], policy: entry.policy, tempCapability,
        config: this.nativeConfig, deadline: Date.now() + Math.max(0, entry.deadlineAt - performance.now()) }, error => {
        if (error) this.retire(worker, 'ipc-failure');
      });
    } catch (error) {
      if (worker.active === entry) entry.finish(this.preparationError(entry, worker.phase, error.message));
    }
  }

  retire(worker, reason, error) {
    if (worker.retiring) return;
    worker.retiring = true;
    const active = worker.active;
    if (active) active.finish(error ?? this.preparationError(active, worker.phase, `Preparation process retired (${reason}).`));
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
    const deadlineAt = started + timeoutMs;
    const details = { mode: policy.mode, started };
    // Admission and enqueue run in one stack. An idle-eviction decision must
    // already see every previous request, including one for a warm worker.
    let slot;
    try { slot = this.slotFor(policy); }
    catch (error) { signal?.throwIfAborted(); throw this.preparationError(details, 'startup', error.message); }
    if (slot.queue.length >= 16) throw this.preparationError(details, 'queue', 'Preparation queue is full.');
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = { ...details, id: ++this.sequence, argv, policy, signal, deadlineAt };
      const finish = entry.finish = (error, result) => {
        if (settled) return;
        // A due timer may run after an IPC callback. The final successful
        // handoff must enforce the same monotonic deadline independently.
        if (!error && performance.now() >= deadlineAt) { entry.expire(); return; }
        settled = true;
        clearTimeout(timer); clearInterval(heartbeat);
        signal?.removeEventListener('abort', abort);
        const worker = slot.worker;
        slot.queue = slot.queue.filter(item => item !== entry);
        if (worker?.active === entry) worker.active = undefined;
        this.log(worker, entry, error ? 'failed' : 'ready');
        error ? reject(error) : resolve(result);
        this.dispatch(slot);
      };
      const stop = (reason, error) => {
        if (slot.worker?.active === entry) this.retire(slot.worker, reason, error);
        else finish(error);
      };
      const abort = () => stop('cancelled', signal.reason ?? new DOMException('Sandbox preparation cancelled', 'AbortError'));
      entry.expire = () => {
        const phase = slot.worker?.active === entry ? slot.worker.phase : 'queue';
        stop('deadline', this.preparationError(entry, phase, `The ${timeoutMs}ms preparation deadline expired.`));
      };
      const timer = setTimeout(entry.expire, Math.max(1, deadlineAt - performance.now()));
      const heartbeat = setInterval(() => this.log(slot.worker, entry, slot.worker?.active === entry ? 'waiting' : 'queued'), 5000);
      signal?.addEventListener('abort', abort, { once: true });
      slot.queue.push(entry);
      if (signal?.aborted) abort();
      else this.dispatch(slot);
    });
  }

  async closePreparation() {
    this.closed = true;
    const workers = [];
    for (const slot of this.slots.values()) {
      if (slot.worker) { workers.push(slot.worker); this.retire(slot.worker, 'provider-closed'); }
      for (const entry of [...slot.queue]) entry.finish(this.preparationError(entry, 'queue', 'Preparation provider closed.'));
    }
    let timer;
    try {
      // Even OS teardown must not hold the embedded Host's shutdown forever.
      await Promise.race([Promise.all(workers.map(worker => worker.closed)),
        new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
    } finally { clearTimeout(timer); }
    const remaining = workers.filter(worker => !worker.exited).length;
    if (remaining) console.warn('[Windows sandbox preparation]', JSON.stringify({
      status: 'cleanup-exit-unconfirmed', workers: remaining }));
  }
}
