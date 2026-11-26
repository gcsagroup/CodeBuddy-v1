import { createHash } from 'node:crypto';

const empty = () => ({ version: 1, revision: 0, paused: false, items: [], commands: {} });
const fail = (message, reason = 'QUEUE_CONFLICT') => Object.assign(new Error(message), { code: -32602, data: { reason } });
const pending = item => item.state === 'pending';
const terminal = item => ['consumed', 'removed'].includes(item.state);
function validateItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
      typeof item.content !== 'string' || !Array.isArray(item.images) ||
      (!item.content.trim() && !item.images.length) || item.images.length > 10 ||
      item.images.some(image => typeof image?.data !== 'string' || typeof image?.mimeType !== 'string') ||
      Buffer.byteLength(JSON.stringify(item)) > 32 * 1024 * 1024)
    throw fail('Invalid queued message', 'QUEUE_INVALID');
}

// This is the delivery ledger before native admission, not a second Agent loop.
// Only native agent_input receipts establish consumption. Unknown admissions
// remain blocked across crashes; no renderer is allowed to replay them.
export class InputQueue {
  constructor(store, { active, cancel, dispatch, inputIds, closing }) {
    Object.assign(this, { store, active, cancel, dispatch, inputIds, closing });
    this.tails = new Map();
    this.workers = new Map();
    this.clients = new Map();
    this.cancellations = new WeakMap();
  }
  read(id) { return this.store.readSession(id)?.inputQueue ?? empty(); }
  snapshot(id) {
    const q = this.read(id);
    const active = this.active(id);
    return { version: 1, revision: q.revision, paused: q.paused,
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
        q.paused = true;
        delete q.selection;
        for (const item of q.items) if (item.state === 'dispatching') item.state = 'uncertain';
        q.revision++;
      });
    }
  }
  async reconcile(id) {
    const q = this.read(id);
    if (!q.items.some(item => ['dispatching', 'uncertain'].includes(item.state))) return;
    const ids = new Set(await this.inputIds(id));
    if (!q.items.some(item => !terminal(item) && ids.has(item.id))) return;
    await this.store.updateSession(id, s => {
      for (const item of s.inputQueue.items) if (ids.has(item.id)) item.state = 'consumed';
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
      if (command.action === 'send' && command.expectedRunId !== runId)
        throw fail('当前执行已变化，请刷新后重试。');
      await this.store.updateSession(id, session => {
        const q = session.inputQueue ??= empty();
        const find = itemId => {
          const item = q.items.find(row => row.id === itemId);
          if (!item || !pending(item) || q.selection?.ids.includes(itemId)) throw fail('消息已开始发送或已被消费，不能再修改。');
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
                if (existing.content !== item.content || JSON.stringify(existing.images) !== JSON.stringify(item.images))
                  throw fail('Message ID was reused');
                continue;
              }
              q.items.push({ id: item.id, content: item.content, images: item.images,
                timestamp: item.timestamp ?? Date.now(), desktopGeneration: item.desktopGeneration ?? '',
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
            for (const item of q.items) if (pending(item)) item.state = 'removed';
            break;
          case 'reorder': {
            if (q.selection) throw fail('A switch is pending');
            const rows = q.items.filter(pending);
            if (!Array.isArray(command.ids) || new Set(command.ids).size !== rows.length ||
                command.ids.length !== rows.length || command.ids.some(key => !rows.some(row => row.id === key)))
              throw fail('Queue order changed');
            const ordered = command.ids.map(key => rows.find(row => row.id === key));
            let index = 0;
            q.items = q.items.map(item => pending(item) ? ordered[index++] : item); break;
          }
          case 'pause': q.paused = true; delete q.selection; break;
          case 'send': {
            if (q.selection || !Array.isArray(command.ids) || !command.ids.length || new Set(command.ids).size !== command.ids.length)
              throw fail('A switch is already pending or the batch is invalid');
            for (const key of command.ids) find(key);
            // Freeze identity, ordering and attachments, not a concatenated string.
            q.selection = { id: command.commandId, ids: command.ids, expectedRunId: runId,
              desktopGeneration: typeof command.desktopGeneration === 'string' ? command.desktopGeneration : '' };
            q.paused = false;
            break;
          }
          default: throw fail('Unknown queue command', 'QUEUE_INVALID');
        }
        q.commands[command.commandId] = fingerprint;
        q.revision++;
      });
      return this.snapshot(id);
    });
    if (command.action === 'send') {
      const active = this.active(id);
      const selection = this.read(id).selection;
      const runId = active?.run?.runId ?? active?.desktopControlToken ?? null;
      if (active && selection?.id === command.commandId && selection.expectedRunId !== null &&
          selection.expectedRunId === runId)
        void this.cancelOnce(id, active, connection).catch(() => this.pause(id));
    }
    this.kick(id);
    return result;
  }
  cancelOnce(id, active, connection) {
    if (!this.cancellations.has(active)) this.cancellations.set(active, Promise.resolve().then(() => this.cancel(id, connection, active)));
    return this.cancellations.get(active);
  }
  async pause(id) {
    return this.serial(id, () => this.store.updateSession(id, session => {
      const q = session.inputQueue ??= empty();
      q.paused = true; delete q.selection; q.revision++;
    }));
  }
  kick(id) {
    if (this.workers.has(id) || this.closing()) return;
    const work = this.drain(id).catch(async () => { await this.pause(id); }).finally(() => {
      this.workers.delete(id);
      const q = this.read(id);
      if (!q.paused && (q.selection || q.items.some(pending))) this.kick(id);
    });
    this.workers.set(id, work);
  }
  async drain(id) {
    while (!this.closing()) {
      let q = this.read(id);
      if (q.paused || (!q.selection && !q.items.some(pending))) return;
      const active = this.active(id);
      if (active) {
        if (q.selection && q.selection.expectedRunId !== null) {
          const runId = active.run?.runId ?? active.desktopControlToken ?? null;
          if (q.selection.expectedRunId !== runId) { await this.pause(id); return; }
          await this.cancelOnce(id, active, this.clients.get(id));
        }
        await active.done;
        continue;
      }
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
      try { result = await promise; }
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
