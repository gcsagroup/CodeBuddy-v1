import { createHash } from 'node:crypto';

const empty = () => ({ version: 1, revision: 0, paused: false, items: [], commands: {} });
const fail = (message, reason = 'QUEUE_CONFLICT') => Object.assign(new Error(message), { code: -32602, data: { reason } });
const pending = item => item.state === 'pending';
const terminal = item => ['consumed', 'removed'].includes(item.state);
const stepInput = item => item.mode === 'steer' || item.deliveryTarget === 'next-step';
function pausePending(q) {
  q.paused = true; delete q.selection;
  for (const item of q.items) if (pending(item) && item.deliveryTarget === 'next-step') {
    delete item.deliveryTarget; delete item.targetRunId;
  }
}
function validateItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
      typeof item.content !== 'string' || !Array.isArray(item.images) ||
      (!item.content.trim() && !item.images.length) || item.images.length > 10 ||
      (item.mode !== undefined && !['queue', 'steer'].includes(item.mode)) ||
      item.images.some(image => typeof image?.data !== 'string' || typeof image?.mimeType !== 'string') ||
      Buffer.byteLength(JSON.stringify(item)) > 32 * 1024 * 1024)
    throw fail('Invalid queued message', 'QUEUE_INVALID');
}

// This is the delivery ledger before native admission, not a second Agent loop.
// Only native agent_input receipts establish consumption. Unknown admissions
// remain blocked across crashes; no renderer is allowed to replay them.
export class InputQueue {
  constructor(store, { active, dispatch, steer, inputIds, closing }) {
    Object.assign(this, { store, active, dispatch, steer, inputIds, closing });
    this.tails = new Map();
    this.workers = new Map();
    this.clients = new Map();
    this.wakeups = new Map();
  }
  read(id) { return this.store.readSession(id)?.inputQueue ?? empty(); }
  snapshot(id) {
    const q = this.read(id);
    const active = this.active(id);
    return { version: 1, revision: q.revision, paused: q.paused, steering: typeof this.steer === 'function',
      activeRunId: active?.run?.runId ?? active?.desktopControlToken ?? null,
      items: q.items.filter(item => !terminal(item)), selection: q.selection ?? null };
  }
  serial(id, fn) {
    const result = (this.tails.get(id) ?? Promise.resolve()).then(fn);
    this.tails.set(id, result.catch(() => {}));
    return result;
  }
  async initialize() {
    for (const session of this.store.read().sessions) {
      if (!session.inputQueue) continue;
      await this.store.updateSession(session.id, s => {
        const q = s.inputQueue;
        pausePending(q);
        for (const item of q.items) if (['dispatching', 'admitted'].includes(item.state)) item.state = 'uncertain';
        q.revision++;
      });
    }
  }
  async reconcile(id) {
    const q = this.read(id);
    if (!q.items.some(item => ['dispatching', 'admitted', 'uncertain'].includes(item.state))) return;
    const ids = new Set(await this.inputIds(id));
    const nativePending = q.items.some(item => item.deliveryTarget === 'next-step' && item.state === 'uncertain')
      ? new Set(await this.inputIds(id, false)) : new Set();
    if (!q.items.some(item => !terminal(item) && (ids.has(item.id) || nativePending.has(item.id)))) return;
    await this.store.updateSession(id, s => {
      for (const item of s.inputQueue.items) {
        if (ids.has(item.id)) item.state = 'consumed';
        else if (item.deliveryTarget === 'next-step' && nativePending.has(item.id)) item.state = 'admitted';
      }
      s.inputQueue.revision++;
    });
  }
  consumed(id, requestId) {
    return this.serial(id, async () => {
      if (!this.read(id).items.some(item => item.id === requestId && !terminal(item))) return;
      await this.store.updateSession(id, s => {
        s.inputQueue.items.find(item => item.id === requestId).state = 'consumed';
        s.inputQueue.revision++;
      });
    });
  }
  async request(id, command, connection) {
    if (!this.store.readSession(id)) throw fail('Session not found');
    if (connection) this.clients.set(id, connection);
    if (command.action === 'get') return this.serial(id, async () => {
      await this.reconcile(id); return { ...this.snapshot(id), commandApplied: Boolean(command.commandId && this.read(id).commands[command.commandId]) };
    });
    const result = await this.serial(id, async () => {
      if (typeof command.commandId !== 'string' || !command.commandId || command.commandId.length > 200)
        throw fail('A stable command ID is required', 'QUEUE_INVALID');
      const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const old = this.read(id);
      if (old.commands[command.commandId]) {
        if (old.commands[command.commandId] !== fingerprint) throw fail('Command ID was reused with different input');
        return this.snapshot(id);
      }
      // Appends commute with consumption; edits and selection still require the observed version.
      if (!['enqueue', 'import'].includes(command.action) && command.revision !== old.revision) throw fail('消息队列已更新，请刷新后重试。');
      const admitted = command.action === 'resolve' ? new Set(await this.inputIds(id, false)) : null;
      const current = this.active(id);
      const runId = current?.run?.runId ?? current?.desktopControlToken ?? null;
      if (command.action === 'next-step' && (!current || current.controller?.signal.aborted || command.expectedRunId !== runId))
        throw fail('当前执行已变化，请刷新后重试。');
      await this.store.updateSession(id, session => {
        const q = session.inputQueue ??= empty();
        const find = itemId => {
          const item = q.items.find(row => row.id === itemId);
          if (!item || !pending(item) || item.deliveryTarget === 'next-step' || q.selection?.ids.includes(itemId)) throw fail('消息已开始发送或已被消费，不能再修改。');
          return item;
        };
        switch (command.action) {
          case 'enqueue':
          case 'import': {
            if (!Array.isArray(command.items) || !command.items.length || command.items.length > 100)
              throw fail('Invalid queue batch', 'QUEUE_INVALID');
            for (const item of command.items) {
              validateItem(item);
              const existing = q.items.find(row => row.id === item.id);
              if (existing) {
                if (existing.content !== item.content || JSON.stringify(existing.images) !== JSON.stringify(item.images) ||
                    (existing.mode ?? 'queue') !== (item.mode ?? 'queue'))
                  throw fail('Message ID was reused');
                continue;
              }
              if (item.mode === 'steer' && command.action !== 'enqueue') throw fail('Steering cannot be imported', 'QUEUE_INVALID');
              if (item.mode === 'steer' && (!this.steer ||
                  (command.expectedRunId !== null && typeof command.expectedRunId !== 'string')))
                throw fail('A steering target is required', 'QUEUE_INVALID');
              if (item.mode === 'steer' && (command.expectedRunId !== runId || current?.controller?.signal.aborted))
                throw fail('当前执行已变化，请刷新后重试。');
              q.items.push({ id: item.id, content: item.content, images: item.images,
                timestamp: item.timestamp ?? Date.now(), desktopGeneration: item.desktopGeneration ?? '',
                ...(item.mode === 'steer' ? { mode: 'steer', targetRunId: command.expectedRunId } : {}),
                state: command.action === 'import' && item.delivery === 'submitting' ? 'uncertain' : 'pending' });
            }
            if (command.action === 'import') q.paused = true;
            break;
          }
          case 'begin-edit':
            if (q.selection) throw fail('A switch is pending');
            find(command.id); q.paused = true; break;
          case 'edit': {
            const item = find(command.id);
            validateItem({ ...item, content: command.content });
            item.content = command.content; break;
          }
          case 'remove': find(command.id).state = 'removed'; break;
          case 'resolve': {
            const item = q.items.find(row => row.id === command.id);
            if (!item || item.state !== 'uncertain' || current || admitted.has(item.id))
              throw fail('发送结果尚不能确认，请等待执行结束后刷新。');
            item.state = 'pending'; q.paused = true; break;
          }
          case 'clear':
            if (q.selection) throw fail('A switch is pending');
            for (const item of q.items) if (pending(item) && item.deliveryTarget !== 'next-step') item.state = 'removed';
            break;
          case 'reorder': {
            if (q.selection) throw fail('A switch is pending');
            const rows = q.items.filter(pending);
            if (rows.some(item => item.deliveryTarget === 'next-step')) throw fail('消息正在接入下一步，请稍后重试。');
            if (!Array.isArray(command.ids) || new Set(command.ids).size !== rows.length ||
                command.ids.length !== rows.length || command.ids.some(key => !rows.some(row => row.id === key)))
              throw fail('Queue order changed');
            const ordered = command.ids.map(key => rows.find(row => row.id === key));
            let index = 0;
            q.items = q.items.map(item => pending(item) ? ordered[index++] : item); break;
          }
          case 'pause': pausePending(q); break;
          case 'next-step': {
            if (!this.steer || q.selection || !Array.isArray(command.ids) || !command.ids.length || new Set(command.ids).size !== command.ids.length)
              throw fail('Invalid next-step selection', 'QUEUE_INVALID');
            const selected = command.ids.map(find);
            if (selected.some(item => item.mode === 'steer')) throw fail('Input is already steering', 'QUEUE_INVALID');
            // Preserve the ordinary queue identity. This selects native next-step
            // admission, not the request-preempting guide mode.
            for (const item of selected) {
              item.deliveryTarget = 'next-step'; item.targetRunId = runId;
              item.desktopGeneration = typeof command.desktopGeneration === 'string' ? command.desktopGeneration : item.desktopGeneration;
            }
            break;
          }
          case 'resume': q.paused = false; delete q.selection; break;
          case 'send': throw fail('旧版停止后发送已停用，请刷新后选择下一 step。', 'QUEUE_INVALID');
          default: throw fail('Unknown queue command', 'QUEUE_INVALID');
        }
        q.commands[command.commandId] = fingerprint;
        q.revision++;
      });
      return this.snapshot(id);
    });
    this.kick(id);
    return result;
  }
  async pause(id) {
    return this.serial(id, () => this.store.updateSession(id, session => {
      const q = session.inputQueue ??= empty();
      pausePending(q); q.revision++;
    }));
  }
  kick(id) {
    this.wakeups.get(id)?.();
    if (this.workers.has(id) || this.closing()) return;
    const work = this.drain(id).catch(async () => { await this.pause(id); }).finally(() => {
      this.workers.delete(id);
      const q = this.read(id);
      if (!q.items.some(item => item.state === 'uncertain') &&
          ((!q.paused && (q.selection || q.items.some(pending))) ||
            (this.active(id) && !q.selection && q.items.some(item => pending(item) && stepInput(item))))) this.kick(id);
    });
    this.workers.set(id, work);
  }
  async waitForActive(id, active) {
    const wake = Promise.withResolvers();
    this.wakeups.set(id, wake.resolve);
    try {
      const finished = await Promise.race([active.done.then(() => true, () => true), wake.promise.then(() => false)]);
      if (finished) await this.serial(id, async () => {
        await this.reconcile(id);
        const nativePending = new Set(await this.inputIds(id, false));
        await this.store.updateSession(id, session => {
          const q = session.inputQueue;
          for (const item of q.items) if (item.state === 'admitted' && item.targetRunId === (active.run?.runId ?? active.desktopControlToken) &&
              !(item.deliveryTarget === 'next-step' && nativePending.has(item.id))) {
            item.state = 'uncertain'; q.paused = true;
          }
          q.revision++;
        });
      });
    } finally { if (this.wakeups.get(id) === wake.resolve) this.wakeups.delete(id); }
  }
  async deliverSteering(id, active, itemId) {
    const delivery = await this.serial(id, async () => {
      const q = this.read(id), item = q.items.find(row => row.id === itemId);
      if (this.active(id) !== active || !item || !pending(item) || !stepInput(item) || q.selection) return;
      const runId = active.run?.runId ?? active.desktopControlToken;
      if (item.targetRunId !== runId) {
        await this.store.updateSession(id, s => {
          const row = s.inputQueue.items.find(row => row.id === itemId);
          if (row.deliveryTarget === 'next-step') {
            // No native admission was attempted. Like DSH's unavailable queue
            // upgrade, leave the original message waiting for its next turn.
            delete row.deliveryTarget; delete row.targetRunId;
          } else { row.state = 'uncertain'; s.inputQueue.paused = true; }
          s.inputQueue.revision++;
        });
        return;
      }
      await this.store.updateSession(id, s => {
        s.inputQueue.items.find(row => row.id === itemId).state = 'dispatching'; s.inputQueue.revision++;
      });
      return { ...item };
    });
    if (!delivery) return;
    let admitted = false;
    try {
      await this.steer(id, delivery, this.clients.get(id), active);
      admitted = true;
    } finally {
      await this.serial(id, async () => {
        await this.reconcile(id);
        await this.store.updateSession(id, s => {
          const q = s.inputQueue, item = q.items.find(row => row.id === itemId);
          if (item.state === 'dispatching') item.state = admitted ? 'admitted' : 'uncertain';
          if (!admitted) q.paused = true;
          q.revision++;
        });
      });
    }
  }
  async waitForDispatch(id, promise) {
    let settled = false;
    const outcome = promise.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    while (!settled) {
      const q = this.read(id), active = this.active(id);
      const item = !q.selection && !q.items.some(row => row.state === 'uncertain') &&
        q.items.find(row => pending(row) && stepInput(row));
      if (active && item) { await this.deliverSteering(id, active, item.id); continue; }
      const wake = Promise.withResolvers();
      this.wakeups.set(id, wake.resolve);
      try { await Promise.race([outcome, wake.promise]); }
      finally { if (this.wakeups.get(id) === wake.resolve) this.wakeups.delete(id); }
    }
    const result = await outcome;
    if (Object.hasOwn(result, 'error')) throw result.error;
    return result.result;
  }
  async drain(id) {
    while (!this.closing()) {
      let q = this.read(id);
      if (q.items.some(item => item.state === 'uncertain')) return;
      const active = this.active(id);
      const runId = active?.run?.runId ?? active?.desktopControlToken ?? null;
      const staleAdmissions = q.items.filter(item => item.state === 'admitted' && item.targetRunId !== runId);
      const staleTargets = new Map(staleAdmissions.map(item => [item.id, item.targetRunId]));
      const nativePending = staleAdmissions.some(item => item.deliveryTarget === 'next-step')
        ? new Set(await this.inputIds(id, false)) : new Set();
      if (staleAdmissions.some(item => item.deliveryTarget !== 'next-step' || !nativePending.has(item.id))) {
        await this.serial(id, async () => {
          await this.reconcile(id);
          await this.store.updateSession(id, s => {
            for (const item of s.inputQueue.items) if (item.state === 'admitted' && staleTargets.has(item.id) &&
                item.targetRunId === staleTargets.get(item.id) &&
                !(item.deliveryTarget === 'next-step' && nativePending.has(item.id))) {
              item.state = 'uncertain'; s.inputQueue.paused = true;
            }
            s.inputQueue.revision++;
          });
        });
        continue;
      }
      if (active) {
        const steer = !q.selection && q.items.find(item => pending(item) && stepInput(item));
        if (steer) { await this.deliverSteering(id, active, steer.id); continue; }
        if ((q.paused && !q.items.some(item => item.state === 'admitted')) ||
            (!q.selection && !q.items.some(item => pending(item) || item.state === 'admitted'))) return;
        if (q.selection && q.selection.expectedRunId !== null) {
          const runId = active.run?.runId ?? active.desktopControlToken ?? null;
          if (q.selection.expectedRunId !== runId) { await this.pause(id); return; }
          // A persisted legacy stop-and-send selection is never reinterpreted.
          await this.pause(id); return;
        }
        await this.waitForActive(id, active);
        continue;
      }
      if (q.items.some(item => pending(item) && item.deliveryTarget === 'next-step')) {
        await this.serial(id, async () => {
          const current = this.active(id), currentRunId = current?.run?.runId ?? current?.desktopControlToken;
          await this.store.updateSession(id, s => {
            for (const item of s.inputQueue.items) if (pending(item) && item.deliveryTarget === 'next-step' &&
                (!current || item.targetRunId !== currentRunId)) {
              delete item.deliveryTarget; delete item.targetRunId;
            }
            s.inputQueue.revision++;
          });
        });
        continue;
      }
      if (q.paused || (!q.selection && !q.items.some(pending))) return;
      const delivery = await this.serial(id, async () => {
        q = this.read(id);
        if (q.paused) return [];
        const ids = q.selection?.ids ?? q.items.filter(pending).slice(0, 1).map(item => item.id);
        if (!ids.length) return [];
        const selected = ids.map(key => q.items.find(row => row.id === key));
        if (selected.some(item => !item || !pending(item))) { await this.store.updateSession(id, s => { s.inputQueue.paused = true; delete s.inputQueue.selection; s.inputQueue.revision++; }); return []; }
        await this.store.updateSession(id, session => {
          for (const item of session.inputQueue.items) if (ids.includes(item.id)) {
            item.state = 'dispatching';
            if (q.selection) item.desktopGeneration = q.selection.desktopGeneration ?? item.desktopGeneration;
          }
          delete session.inputQueue.selection;
          session.inputQueue.revision++;
        });
        // A direct prompt can acquire the owner while the durable write awaits.
        // No input was admitted yet: retain it as pending and wait for that owner,
        // rather than treating a local admission conflict as an unknown delivery.
        if (this.active(id)) {
          await this.store.updateSession(id, session => {
            const queue = session.inputQueue;
            for (const item of queue.items) if (ids.includes(item.id)) item.state = 'pending';
            if (q.selection) queue.selection = { ...q.selection, expectedRunId: null };
            queue.revision++;
          });
          return { retry: true };
        }
        const batch = selected.map(item => ({ ...item, desktopGeneration: q.selection?.desktopGeneration ?? item.desktopGeneration }));
        // Establish the existing prompt owner before a serialized Stop can run.
        const promise = this.dispatch(id, batch, this.clients.get(id));
        promise.catch(() => {});
        return { batch, promise };
      });
      if (delivery.retry) continue;
      if (!delivery.batch) return;
      const { batch, promise } = delivery;
      let result;
      try { result = await this.waitForDispatch(id, promise); }
      finally {
        await this.serial(id, async () => {
          await this.reconcile(id);
          await this.store.updateSession(id, session => {
            const queue = session.inputQueue;
            for (const item of queue.items) if (batch.some(row => row.id === item.id) && item.state === 'dispatching') item.state = 'uncertain';
            if ((!queue.selection && result?.stopReason !== 'end_turn') || queue.items.some(item => item.state === 'uncertain')) queue.paused = true;
            queue.revision++;
          });
        });
      }
    }
  }
}
