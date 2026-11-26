import { useCallback, useEffect, useRef, useState } from 'react';
import { inputQueueRequest, type InputQueueSnapshot } from '../acp/inputQueue';
import { QueuedMessageStorage } from '../utils/queuedMessageStorage';

const empty: InputQueueSnapshot = { version: 1, revision: 0, paused: true, activeRunId: null, items: [], selection: null };
type Command = Record<string, unknown>;
export function useInputQueue(sessionId?: string) {
  const [snapshot, setSnapshot] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const state = useRef({ sessionId, snapshot: empty, ready: false, busy: false, pending: null as Command | null,
    accepted: undefined as (() => void) | undefined });
  if (state.current.sessionId !== sessionId) state.current = { sessionId, snapshot: empty, ready: false, busy: false, pending: null, accepted: undefined };
  const clientId = useRef<string | null>(null);
  const operationKey = (id: string) => {
    if (!clientId.current) {
      clientId.current = window.sessionStorage.getItem('codebuddy-queue-window') ?? crypto.randomUUID();
      window.sessionStorage.setItem('codebuddy-queue-window', clientId.current);
    }
    return `codebuddy-queue-command:v1:${clientId.current}:${encodeURIComponent(id)}`;
  };
  const publish = useCallback((owner: typeof state.current, next: InputQueueSnapshot) => {
    if (state.current !== owner) return;
    if (next.revision >= owner.snapshot.revision) { owner.snapshot = next; setSnapshot(next); }
  }, []);
  const refresh = useCallback(async () => {
    const owner = state.current;
    if (!owner.sessionId) return;
    const next = await inputQueueRequest(owner.sessionId, { action: 'get', commandId: owner.pending?.commandId });
    publish(owner, next);
    if (state.current === owner && owner.pending && next.commandApplied) {
      localStorage.removeItem(operationKey(owner.sessionId));
      owner.pending = null; owner.accepted?.(); owner.accepted = undefined;
      owner.busy = false; setBusy(false); setError(null);
    }
    return next;
  }, [publish]);
  const mutate = useCallback(async (command: Command, accepted?: () => void, staged?: () => void) => {
    const owner = state.current;
    if (!owner.sessionId || !owner.ready || owner.busy || owner.pending) return false;
    owner.busy = true; setBusy(true); setError(null);
    const request = { ...command, revision: owner.snapshot.revision, commandId: crypto.randomUUID() };
    owner.pending = request; owner.accepted = accepted;
    let persisted = false;
    try {
      localStorage.setItem(operationKey(owner.sessionId), JSON.stringify(request));
      persisted = true;
      staged?.();
      const next = await inputQueueRequest(owner.sessionId, request);
      localStorage.removeItem(operationKey(owner.sessionId));
      if (state.current !== owner) return true;
      publish(owner, next); owner.pending = null; owner.accepted = undefined;
      accepted?.(); return true;
    } catch (reason) {
      if (state.current === owner) {
        setError(reason instanceof Error ? reason.message : '消息队列操作失败，请刷新确认发送结果。');
        // A structured validation failure proves the command was not committed.
        // Enqueued input may already have left the composer after durable staging.
        // Retain it for retry even on a definite rejection; edits keep their editor.
        if (!persisted || ((reason as { code?: number })?.code === -32602 && command.action !== 'enqueue')) {
          if (persisted) localStorage.removeItem(operationKey(owner.sessionId));
          owner.pending = null; owner.accepted = undefined;
        }
      }
      return false;
    } finally { if (state.current === owner) { owner.busy = false; setBusy(false); } }
  }, [publish]);
  const retry = useCallback(async () => {
    const owner = state.current;
    if (!owner.sessionId || owner.busy) return;
    try {
      const current = await refresh();
      if (!owner.pending || !current || state.current !== owner) { setError(null); return; }
      // Retry the exact durable command ID and payload, never a new delivery.
      owner.busy = true; setBusy(true);
      const next = await inputQueueRequest(owner.sessionId, owner.pending);
      publish(owner, next);
      localStorage.removeItem(operationKey(owner.sessionId));
      owner.pending = null; owner.accepted?.(); owner.accepted = undefined; setError(null);
    } catch (reason) {
      if (state.current === owner) {
        setError(reason instanceof Error ? reason.message : '消息队列操作失败');
        if ((reason as {code?: number}).code === -32602 && owner.pending?.action !== 'enqueue') {
          localStorage.removeItem(operationKey(owner.sessionId)); owner.pending = null; owner.accepted = undefined;
        }
      }
    } finally { if (state.current === owner) { owner.busy = false; setBusy(false); } }
  }, [publish, refresh]);
  useEffect(() => {
    const owner = state.current;
    let stopped = false, polling = false;
    setSnapshot(empty); setError(null); setBusy(false);
    if (!sessionId) return;
    const start = async () => {
      try {
        const raw = localStorage.getItem(operationKey(sessionId));
        owner.pending = raw ? JSON.parse(raw) : null;
        await refresh();
        if (stopped) return;
        owner.ready = true;
        const legacy = new QueuedMessageStorage(localStorage, sessionId);
        const legacyRaw = localStorage.getItem(legacy.key);
        const items = legacy.read();
        if (items.length && !owner.pending) {
          if (await mutate({ action: 'import', items }) && localStorage.getItem(legacy.key) === legacyRaw) localStorage.removeItem(legacy.key);
        }
        if (owner.pending) setError('上次操作的回执尚未确认，请刷新或重试确认。');
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : '无法读取消息队列'); }
    };
    void start();
    const timer = setInterval(async () => {
      if (stopped || polling || owner.busy) return;
      polling = true;
      try { if (!owner.ready) await start(); else await refresh(); } catch { /* Writes still require a server revision. */ }
      finally { polling = false; }
    }, 750);
    return () => { stopped = true; clearInterval(timer); };
  }, [sessionId, mutate, refresh]);
  return { snapshot, error, busy: busy || !!state.current.pending, mutate, retry,
    savingInput: busy && state.current.pending?.action === 'enqueue',
    ready: state.current.ready, refresh };
}
