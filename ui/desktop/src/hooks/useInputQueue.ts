import { useCallback, useEffect, useRef, useState } from 'react';
import { inputQueueRequest, type InputQueueSnapshot } from '../acp/inputQueue';
import { QueuedMessageStorage } from '../utils/queuedMessageStorage';

const empty: InputQueueSnapshot = { version: 1, revision: 0, paused: true, activeRunId: null, items: [], selection: null };
type Command = Record<string, unknown>;
type Request = Command & { commandId: string };
type Pending = { request: Request; recovered: boolean; accepted?: () => void; resolve?: (ok: boolean) => void };
const createOwner = (sessionId?: string) => ({ sessionId, snapshot: empty, ready: false, attached: false,
  sending: false, checking: false, blocked: false, rejectedInput: false, error: null as string | null, commands: [] as Pending[] });
type Owner = ReturnType<typeof createOwner>;
const recoveryNotice = '上次操作的回执尚未确认，请刷新或重试确认。';
function readRequest(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof (value as Request).commandId !== 'string' || !(value as Request).commandId ||
      typeof (value as Request).action !== 'string' || !Number.isSafeInteger((value as Request).revision))
    throw new Error('本机待发送记录无效，原始记录已保留。');
  return value as Request;
}

export function useInputQueue(sessionId?: string) {
  const [, redraw] = useState(0);
  const state = useRef(createOwner(sessionId));
  if (state.current.sessionId !== sessionId) state.current = createOwner(sessionId);
  const clientId = useRef<string | null>(null);
  const operationKey = useCallback((id: string, version = 2) => {
    if (!clientId.current) {
      clientId.current = window.sessionStorage.getItem('codebuddy-queue-window') ?? crypto.randomUUID();
      window.sessionStorage.setItem('codebuddy-queue-window', clientId.current);
    }
    return 'codebuddy-queue-command:v' + version + ':' + clientId.current + ':' + encodeURIComponent(id);
  }, []);
  const current = useCallback((owner: Owner) => state.current === owner && owner.attached, []);
  const notify = useCallback((owner: Owner) => { if (current(owner)) redraw(value => value + 1); }, [current]);
  const publish = useCallback((owner: Owner, next: InputQueueSnapshot) => {
    if (current(owner) && next.revision >= owner.snapshot.revision) { owner.snapshot = next; notify(owner); }
  }, [current, notify]);
  const save = useCallback((owner: Owner, commands: Pending[]) => {
    const key = operationKey(owner.sessionId!);
    if (commands.length) localStorage.setItem(key, JSON.stringify({ version: 2, commands: commands.map(entry => entry.request) }));
    else localStorage.removeItem(key);
  }, [operationKey]);
  const finishHead = useCallback((owner: Owner, commandId: string) => {
    if (!current(owner) || owner.commands[0]?.request.commandId !== commandId) return false;
    const [head, ...remaining] = owner.commands;
    // Read the current tail after the await: new input may have been appended.
    save(owner, remaining);
    owner.commands = remaining;
    owner.rejectedInput = false;
    owner.blocked = remaining.some(entry => entry.recovered);
    owner.error = owner.blocked ? recoveryNotice : null;
    head.resolve?.(true); head.resolve = undefined;
    head.accepted?.(); head.accepted = undefined;
    notify(owner);
    return true;
  }, [current, notify, save]);
  const pump = useCallback(async (owner: Owner) => {
    if (!current(owner) || owner.sending || owner.checking || owner.blocked || !owner.commands.length) return;
    owner.sending = true; notify(owner);
    try {
      while (current(owner) && !owner.blocked && owner.commands.length) {
        const head = owner.commands[0];
        try {
          const next = await inputQueueRequest(owner.sessionId!, head.request);
          if (!current(owner)) { head.resolve?.(false); return; }
          publish(owner, next);
          finishHead(owner, head.request.commandId);
        } catch (reason) {
          if (!current(owner)) { head.resolve?.(false); return; }
          owner.error = reason instanceof Error ? reason.message : '消息队列操作失败，请刷新确认发送结果。';
          owner.blocked = true;
          owner.rejectedInput = head.request.action === 'enqueue' && (reason as { code?: number })?.code === -32602;
          head.resolve?.(false); head.resolve = undefined;
          // A rejected edit keeps its editor. Enqueued input has already left the
          // composer, so even definite rejection must retain its durable record.
          if ((reason as { code?: number })?.code === -32602 && head.request.action !== 'enqueue') {
            const message = owner.error;
            head.accepted = undefined;
            try { finishHead(owner, head.request.commandId); owner.error = message; }
            catch (storageError) { owner.error = String(storageError); }
          }
          break;
        }
      }
    } finally { owner.sending = false; notify(owner); }
  }, [current, finishHead, notify, publish]);
  const refresh = useCallback(async () => {
    const owner = state.current;
    if (!owner.sessionId) return;
    const queriedId = owner.commands[0]?.request.commandId;
    const next = await inputQueueRequest(owner.sessionId, { action: 'get', commandId: queriedId });
    if (!current(owner)) return next;
    publish(owner, next);
    // A GET cannot release an outstanding POST or settle a later command.
    if (!owner.sending && queriedId && next.commandApplied) {
      finishHead(owner, queriedId);
      void pump(owner);
    }
    return next;
  }, [current, finishHead, publish, pump]);
  const mutate = useCallback(async (command: Command, accepted?: () => void, staged?: () => void) => {
    const owner = state.current;
    const append = command.action === 'enqueue';
    if (!owner.sessionId || !owner.ready || !current(owner) || owner.blocked || owner.checking ||
        (owner.commands.length > 0 && (!append || owner.commands.some(entry => entry.request.action !== 'enqueue')))) return false;
    // Freeze nested items and attachments too: the backend fingerprints the
    // entire request, including the original revision and run target.
    const request = JSON.parse(JSON.stringify({ ...command, revision: owner.snapshot.revision, commandId: crypto.randomUUID() })) as Request;
    const completion = new Promise<boolean>(resolve => {
      const entry: Pending = { request, recovered: false, accepted, resolve };
      try {
        const commands = [...owner.commands, entry];
        save(owner, commands);
        owner.commands = commands; owner.error = null;
        staged?.(); notify(owner);
      } catch (reason) {
        owner.blocked = true;
        owner.error = reason instanceof Error ? reason.message : '无法保存待发送消息，草稿已保留。';
        resolve(false); notify(owner);
      }
    });
    void pump(owner);
    return completion;
  }, [current, notify, pump, save]);
  const retry = useCallback(async () => {
    const owner = state.current;
    if (!owner.sessionId || !owner.ready || owner.sending || owner.checking) return;
    const commandId = owner.commands[0]?.request.commandId;
    owner.checking = true; notify(owner);
    try {
      await refresh();
      if (!current(owner)) return;
      if (!commandId || owner.commands[0]?.request.commandId === commandId) {
        if (owner.commands[0]) owner.commands[0].recovered = false;
        owner.blocked = false; owner.error = null;
      }
    } catch (reason) { if (current(owner)) { owner.blocked = true; owner.error = String(reason); } }
    finally { owner.checking = false; notify(owner); }
    await pump(owner);
  }, [current, notify, pump, refresh]);
  const requeueRejected = useCallback(async () => {
    const owner = state.current, head = owner.commands[0];
    if (!current(owner) || !owner.rejectedInput || head?.request.action !== 'enqueue' ||
        !Array.isArray(head.request.items) || owner.sending || owner.checking) return;
    // Only explicit user choice can change a definitely rejected destination.
    const request = { action: 'enqueue', revision: owner.snapshot.revision, commandId: crypto.randomUUID(),
      items: head.request.items.map(item => ({ ...item, mode: 'queue' })) };
    try {
      const commands = [{ ...head, request, recovered: false }, ...owner.commands.slice(1)];
      save(owner, commands); owner.commands = commands;
      owner.rejectedInput = false; owner.blocked = false; owner.error = null;
      await pump(owner);
    } catch (reason) { owner.blocked = true; owner.error = String(reason); notify(owner); }
  }, [current, notify, pump, save]);
  useEffect(() => {
    const owner = state.current;
    owner.attached = true;
    let stopped = false, polling = false;
    if (!sessionId) return () => { owner.attached = false; };
    const start = async () => {
      try {
        const raw = localStorage.getItem(operationKey(sessionId));
        const stored = raw ? JSON.parse(raw) : { version: 2, commands: [] };
        if (stored.version !== 2 || !Array.isArray(stored.commands)) throw new Error('本机待发送记录无效，原始记录已保留。');
        const requests: Request[] = stored.commands.map(readRequest);
        if (new Set(requests.map(request => request.commandId)).size !== requests.length) throw new Error('本机待发送记录存在冲突，原始记录已保留。');
        const legacyCommand = localStorage.getItem(operationKey(sessionId, 1));
        if (legacyCommand) {
          const request = readRequest(JSON.parse(legacyCommand));
          if (requests.length && JSON.stringify(requests[0]) !== JSON.stringify(request)) throw new Error('新旧待发送记录冲突，原始记录已保留。');
          if (!requests.length) requests.push(request);
          localStorage.setItem(operationKey(sessionId), JSON.stringify({ version: 2, commands: requests }));
          localStorage.removeItem(operationKey(sessionId, 1));
        }
        owner.commands = requests.map(request => ({ request, recovered: true }));
        owner.blocked = requests.length > 0;
        await refresh();
        if (stopped || !current(owner)) return;
        owner.ready = true;
        const legacy = new QueuedMessageStorage(localStorage, sessionId);
        const legacyRaw = localStorage.getItem(legacy.key), items = legacy.read();
        if (items.length && !owner.commands.length &&
            await mutate({ action: 'import', items }) && localStorage.getItem(legacy.key) === legacyRaw) localStorage.removeItem(legacy.key);
        if (owner.commands.length) owner.error = recoveryNotice;
        notify(owner);
      } catch (reason) { if (!stopped && current(owner)) { owner.error = String(reason); notify(owner); } }
    };
    void start();
    const timer = setInterval(async () => {
      if (stopped || polling || owner.sending || owner.checking) return;
      polling = true;
      try { if (!owner.ready) await start(); else await refresh(); }
      catch (reason) { if (current(owner) && owner.commands.length) { owner.blocked = true; owner.error = String(reason); notify(owner); } }
      finally { polling = false; }
    }, 750);
    return () => {
      stopped = true; clearInterval(timer); owner.attached = false;
      for (const entry of owner.commands) { entry.resolve?.(false); entry.resolve = undefined; entry.accepted = undefined; }
    };
  }, [sessionId, current, mutate, notify, operationKey, refresh]);
  const owner = state.current, head = owner.commands[0]?.request;
  const busy = owner.sending || owner.checking || owner.commands.length > 0;
  const pendingInputs = owner.commands.flatMap(({ request }) => request.action === 'enqueue' && Array.isArray(request.items)
    ? request.items.filter(item => item && typeof item.id === 'string' && typeof item.content === 'string')
      .map(item => ({ id: item.id as string, content: item.content as string, mode: item.mode === 'steer' ? 'steer' : 'queue', attachmentCount: Array.isArray(item.images) ? item.images.length : 0 })) : []);
  return { snapshot: owner.snapshot, error: owner.error, busy, mutate, retry, requeueRejected, pendingInputs,
    canEnqueue: owner.ready && !owner.blocked && !owner.checking && owner.commands.every(entry => entry.request.action === 'enqueue'),
    canRequeueRejected: !!head && owner.rejectedInput && !owner.sending && !owner.checking,
    savingInput: owner.sending && head?.action === 'enqueue',
    savingSteering: owner.sending && head?.action === 'enqueue' && Array.isArray(head.items) && head.items.length > 0 && head.items.every(item => item.mode === 'steer'),
    ready: owner.ready, refresh };
}
