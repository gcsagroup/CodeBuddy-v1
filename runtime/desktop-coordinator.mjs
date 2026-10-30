import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const desktopDirectory = () => process.env.CODEBUDDY_DESKTOP_CONTROL_DIRECTORY ||
  join(process.env.LOCALAPPDATA || homedir(), 'CodeBuddy', 'desktop-control-v1');
export const isDesktopTool = name => /^mcp__qwen_computer__(open_path|list_apps|get_app_state|click|press_key|type_text|drag|scroll|set_value|perform_secondary_action)$/.test(name);
const pausedMessage = 'DESKTOP_PAUSED: 电脑操作已暂停，原任务未取消。继续能够独立完成的思考和非桌面工作，不必结束整个任务；如果下一步必须使用电脑，再说明受阻部分。不添加恢复提示。不要自行解除暂停或重放结果未知的动作。';
const staleMessage = 'DESKTOP_OBSERVATION_EXPIRED: 控制权已变更。未执行本次操作；先重新观察目标窗口，再决定下一步，不要重放之前结果未知的操作。';
const stoppedMessage = 'DESKTOP_STOPPED: 本轮电脑控制已被打断，整个任务没有停止。本次桌面动作可能部分完成；本轮不要再调用电脑工具，也不要换用脚本或其他输入方式。继续能够独立完成的思考和非桌面工作；只有剩余步骤必须使用电脑时，简要说明已完成和未完成部分，不反复重试或声称全部完成。不要求用户点击恢复按钮，不重放结果未知的动作。';
const unavailableMessage = 'DESKTOP_UNAVAILABLE: 电脑控制连接的身份校验未通过，本轮不再使用电脑工具。本次未派发输入；不要重试或改用脚本输入。整个任务继续完成其他独立工作，简要说明受阻部分，不添加恢复提示。';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const controlError = (desktopOutcome, message) => Object.assign(new Error(message), { desktopOutcome });
const pauseReasons = new Set(['escape', 'input_conflicts', 'mouse', 'keyboard', 'cancelled', 'owner_lost', 'manual']);
const stoppedReasons = new Set(['escape', 'input_conflicts']);

// This owns only one shared desktop resource. Harness still owns the task loop,
// approvals and completion. The marker also fences other profiles and native input.
export class DesktopCoordinator {
  constructor({ directory = desktopDirectory(), notify = () => {} } = {}) {
    this.directory = directory;
    this.notify = notify;
    this.leasePath = join(directory, 'lease.json');
    this.pausePath = join(directory, 'paused');
    this.epochPath = join(directory, 'epoch');
    this.contextPath = join(directory, 'paused-context.json');
    this.turns = new Map();
    this.queue = [];
  }
  readLease() {
    try {
      const lease = JSON.parse(readFileSync(this.leasePath, 'utf8'));
      if (!lease || lease.version !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 ||
          !['sessionId', 'token', 'generation'].every(key => typeof lease[key] === 'string' && lease[key].length > 0))
        return { unknown: true };
      return lease;
    }
    catch (e) { if (e.code === 'ENOENT') return null; return { unknown: true }; }
  }
  readPause() {
    try {
      const raw = readFileSync(this.pausePath, 'utf8');
      try {
        const value = JSON.parse(raw);
        if (typeof value?.revision === 'string' && value.revision)
          return { revision: value.revision, reason: pauseReasons.has(value.reason) ? value.reason : 'unknown' };
      } catch { /* Older releases stored only the revision. */ }
      return { revision: raw, reason: 'unknown' };
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  pauseRevision() { return this.readPause()?.revision ?? null; }
  epoch() { try { return readFileSync(this.epochPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
  hold(reason = 'owner_lost') {
    mkdirSync(this.directory, { recursive: true });
    try { writeFileSync(this.pausePath, JSON.stringify({ revision: randomUUID(), reason, at: new Date().toISOString() }), { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  async preparePrompt(sessionId, { activeInput = false, token, generation } = {}) {
    // A new explicit prompt starts a new desktop episode without reviving the
    // old task. Never release an in-flight action or another live chat's lease.
    this.publish();
    const pause = this.readPause();
    if (generation !== undefined && generation !== (pause?.revision ?? this.epoch())) {
      const turn = this.turns.get(token);
      if (turn?.sessionId === sessionId) {
        turn.desktopStopped = true;
        turn.desktopAbort.abort(controlError('stopped', turn.failureMessage ?? stoppedMessage));
      }
      return;
    }
    if (!pause) {
      const turn = this.turns.get(token);
      if (turn?.sessionId === sessionId) { turn.desktopStopped = false; delete turn.failureMessage; turn.conflicts = 0; turn.epoch = this.epoch(); turn.desktopAbort = new AbortController(); }
      return;
    }
    if ([...this.turns.values()].some(t => t.inFlight)) return;
    const lease = this.readLease();
    if (lease && !lease.unknown && alive(lease.pid) &&
        (!activeInput || lease.pid !== process.pid || lease.sessionId !== sessionId)) return;
    await this.resume(pause.revision, { token: token ?? null });
  }
  state() {
    const pause = this.readPause();
    let owner = this.readLease();
    if (!owner && this.pauseRevision()) {
      try { const saved = JSON.parse(readFileSync(this.contextPath, 'utf8')); if (saved.revision === this.pauseRevision()) owner = saved.owner; } catch {}
    }
    return { paused: pause !== null, revision: pause?.revision ?? null, generation: pause?.revision ?? this.epoch(), ...(pause ? { pauseReason: pause.reason } : {}),
      owner: owner && !owner.unknown ? { sessionId: owner.sessionId, title: owner.title, token: owner.token } : null,
      queue: this.queue.map(t => ({ sessionId: t.sessionId, title: t.title, token: t.token })) };
  }
  publish() {
    const state = this.state();
    // Keep the interruption fence after the pause marker is retired, including
    // for messages that were composed earlier but delivered from a UI queue.
    if (stoppedReasons.has(state.pauseReason) && this.epoch() !== state.revision)
      writeFileSync(this.epochPath, state.revision);
    const epoch = this.epoch();
    for (const turn of this.turns.values()) {
      if (stoppedReasons.has(state.pauseReason) || turn.epoch !== epoch) {
        turn.desktopStopped = true;
        turn.desktopAbort.abort(controlError('stopped', turn.failureMessage ?? stoppedMessage));
      }
    }
    if (stoppedReasons.has(state.pauseReason)) {
      // Human takeover revokes pending desktop work too. Otherwise another chat
      // can immediately grab the pointer, or remain stuck waiting for an unlock.
      const lease = this.readLease();
      const owner = this.turns.get(lease?.token);
      if (lease?.pid === process.pid && owner && !owner.inFlight) {
        writeFileSync(this.contextPath, JSON.stringify({ revision: state.revision, owner: lease }));
        unlinkSync(this.leasePath);
      }
    }
    const fingerprint = JSON.stringify(state);
    if (fingerprint === this.lastState) return;
    this.lastState = fingerprint;
    this.notify(state);
    for (const turn of this.turns.values()) turn.present?.({
      active: !state.paused && state.owner?.token === turn.token,
      phase: state.paused ? 'paused' : state.owner?.token === turn.token ? 'active' : this.queue.includes(turn) ? 'waiting' : 'idle',
    });
  }
  begin({ sessionId, token, title, signal, present }) {
    const turn = { sessionId, token, title: title || '电脑控制任务', signal, present,
      tail: Promise.resolve(), inFlight: 0, conflicts: 0, notifiedPause: false, closed: false, epoch: this.epoch(), desktopAbort: new AbortController() };
    this.turns.set(token, turn);
    const cancel = () => { if (this.readLease()?.token === token) this.hold('cancelled'); this.publish(); };
    signal?.addEventListener('abort', cancel, { once: true });
    return {
      admit: async (tool, next) => {
        if (!isDesktopTool(tool.name)) return next(tool.signal ?? turn.signal);
        this.publish();
        if (turn.desktopStopped || turn.epoch !== this.epoch()) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
        // Only desktop policy/approval waits are interrupted. Harness and other
        // tool approvals retain their original cancellation signals.
        const scoped = AbortSignal.any([turn.desktopAbort.signal, tool.signal ?? turn.signal].filter(Boolean));
        scoped.throwIfAborted();
        try {
          const result = await next(scoped);
          scoped.throwIfAborted();
          return result;
        } catch (error) {
          // RPC transports may replace the abort reason with AbortError. Keep
          // the desktop interruption distinct from cancellation of the task.
          scoped.throwIfAborted();
          throw error;
        }
      },
      execute: (tool, next) => {
        if (!isDesktopTool(tool.name)) return next();
        const work = turn.tail.then(() => this.execute(turn, tool, next));
        turn.tail = work.catch(() => {});
        return work;
      },
      metadata: () => {
        this.publish();
        if (turn.epoch !== this.epoch()) turn.desktopStopped = true;
        if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
        if (this.pauseRevision() !== null) throw controlError('paused', pausedMessage);
        const owner = this.readLease();
        if (owner?.token !== turn.token) throw controlError('stale', staleMessage);
        return { 'codebuddy/desktop-control': { version: 1, token: turn.token, generation: owner.generation } };
      },
      end: async () => {
        turn.closed = true;
        await turn.tail;
        signal?.removeEventListener('abort', cancel);
        this.turns.delete(token);
        this.queue = this.queue.filter(t => t !== turn);
        if (this.readLease()?.token === token) {
          if (this.pauseRevision()) writeFileSync(this.contextPath, JSON.stringify({
            revision: this.pauseRevision(), owner: turn.signal?.aborted ? null : this.readLease(),
          }));
          unlinkSync(this.leasePath);
          // Stop fences native input until cleanup finishes, then releases the
          // resource. It must not leave future tasks behind a global latch.
          if (turn.signal?.aborted && this.readPause())
            unlinkSync(this.pausePath);
        }
        present?.({ active: false, phase: 'idle' });
        if (!this.turns.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
        this.publish();
      },
    };
  }
  async execute(turn, tool, next) {
    turn.signal ??= tool.signal;
    turn.signal?.throwIfAborted();
    if (turn.closed) throw Error('Desktop turn has ended');
    this.publish();
    if (turn.epoch !== this.epoch()) turn.desktopStopped = true;
    if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
    if (turn.withdrawn) throw controlError('withdrawn', 'DESKTOP_WITHDRAWN: 用户已退出本轮电脑控制排队；原任务保留，继续独立的非桌面工作。');
    mkdirSync(this.directory, { recursive: true });
    if (!this.timer) {
      this.timer = setInterval(() => {
        try {
          const owner = this.readLease();
          if (owner && (owner.unknown || !alive(owner.pid))) this.hold();
          this.publish();
        } catch { this.hold(); }
      }, 75);
      this.timer.unref();
    }
    if (this.pauseRevision() !== null) {
      this.publish();
      if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
      if (turn.notifiedPause) {
        // A repeated model call waits locally, instead of spending more model
        // turns polling. On resume this old proposal must be observed anew.
        while (this.pauseRevision() !== null) {
          this.publish();
          if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
          await delay(75, undefined, { signal: turn.signal });
        }
        turn.notifiedPause = false;
        throw controlError('stale', staleMessage);
      }
      turn.notifiedPause = true;
      throw controlError('paused', pausedMessage);
    }
    const queuedRevision = this.pauseRevision(), epoch = this.epoch();
    if (!this.queue.includes(turn)) this.queue.push(turn);
    try {
      for (;;) {
        turn.signal?.throwIfAborted();
        if (turn.closed) throw Error('Desktop turn has ended');
        this.publish();
        if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
        if (turn.withdrawn) throw controlError('withdrawn', 'DESKTOP_WITHDRAWN: 用户已退出排队，未执行本次操作。');
        if (this.epoch() !== epoch) throw controlError('stale', staleMessage);
        if (this.pauseRevision() !== queuedRevision) { turn.notifiedPause = true; throw controlError('paused', pausedMessage); }
        const owner = this.readLease();
        if (owner?.token === turn.token) break;
        if (!owner && this.queue[0] === turn) {
          try {
            writeFileSync(this.leasePath, JSON.stringify({ version: 1, pid: process.pid,
              sessionId: turn.sessionId, token: turn.token, title: turn.title, generation: randomUUID() }), { flag: 'wx' });
            break;
          } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        if (owner && (owner.unknown || !alive(owner.pid))) this.hold();
        this.publish();
        await delay(75, undefined, { signal: turn.signal });
      }
    } finally { this.queue = this.queue.filter(t => t !== turn); this.publish(); }
    if (this.pauseRevision() !== null) { turn.notifiedPause = true; throw controlError('paused', pausedMessage); }
    turn.inFlight++;
    delete tool.desktopControlReceipt;
    try {
      let result;
      try { result = await next(); }
      finally {
        // Count once per native receipt, including a successful fresh-state-only
        // response. Observation and unrelated failures never reset this streak.
        const receipt = tool.desktopControlReceipt;
        if (receipt?.schema_version === 1) {
          if (receipt.outcome === 'input_conflict') {
            if (++turn.conflicts >= 3) this.hold('input_conflicts');
          } else if (receipt.outcome === 'control_unavailable') {
            turn.desktopStopped = true;
            turn.failureMessage = unavailableMessage;
            turn.desktopAbort.abort(controlError('stopped', unavailableMessage));
          } else if (receipt.outcome === 'action_completed' &&
              !['mcp__qwen_computer__list_apps', 'mcp__qwen_computer__get_app_state'].includes(tool.name)) turn.conflicts = 0;
        }
      }
      this.publish();
      if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
      if (this.pauseRevision() !== null) { turn.notifiedPause = true; throw controlError('paused', pausedMessage + ' 本次已派发动作的结果尚未核对，不要重复派发。'); }
      return result;
    } catch (error) {
      this.publish();
      if (turn.desktopStopped) throw controlError('stopped', turn.failureMessage ?? stoppedMessage);
      if (this.pauseRevision() !== null) { turn.notifiedPause = true; throw controlError('paused', pausedMessage + ' 已派发动作可能部分完成，不要重复派发。'); }
      throw error;
    } finally {
      turn.inFlight--;
      // A broken native connection ends only this turn's desktop access. Other
      // chats can use their own valid connection once this call has settled.
      if (turn.failureMessage && !turn.inFlight && this.readLease()?.token === turn.token)
        unlinkSync(this.leasePath);
      this.publish();
    }
  }
  pause(sessionId, token, reason = 'manual') {
    const owner = this.readLease();
    if (!owner || owner.unknown || owner.sessionId !== sessionId || owner.token !== token) return false;
    this.hold(pauseReasons.has(reason) ? reason : 'manual');
    this.publish();
    return true;
  }
  discardContinuation(sessionId, token) {
    // Cancellation can arrive after the native turn released its lease but
    // before Compat finishes persistence. Retire only that saved turn.
    try {
      const saved = JSON.parse(readFileSync(this.contextPath, 'utf8'));
      if (saved.revision === this.pauseRevision() && saved.owner?.sessionId === sessionId && saved.owner?.token === token) {
        writeFileSync(this.contextPath, JSON.stringify({ revision: saved.revision, owner: null }));
        if (!this.readLease()) unlinkSync(this.pausePath);
        this.publish();
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async resume(revision, { token = this.state().owner?.token } = {}) {
    if (!revision || revision !== this.pauseRevision()) throw Error('电脑控制状态已变化，请刷新后重试。');
    if ([...this.turns.values()].some(t => t.inFlight)) throw Error('正在收尾当前动作，请稍后恢复电脑控制。');
    const owner = this.readLease();
    const pausedSessionId = this.state().owner?.sessionId;
    // No queued proposal is replayed. A fresh lease also invalidates native snapshots.
    if (owner && !owner.unknown && owner.pid !== process.pid && alive(owner.pid)) throw Error('请在占用桌面的 CodeBuddy 窗口中恢复控制。');
    if (owner) unlinkSync(this.leasePath);
    writeFileSync(this.epochPath, revision);
    unlinkSync(this.pausePath);
    for (const t of this.turns.values()) {
      t.notifiedPause = false;
      if (t.token === token) { t.desktopStopped = false; delete t.failureMessage; t.conflicts = 0; t.epoch = this.epoch(); t.desktopAbort = new AbortController(); }
    }
    this.publish();
    return { ...this.state(), pausedSessionId };
  }
  withdraw(sessionId, token) {
    const turn = this.queue.find(t => t.sessionId === sessionId && t.token === token);
    if (turn) { turn.withdrawn = true; this.queue = this.queue.filter(t => t !== turn); this.publish(); }
    return this.state();
  }
}
