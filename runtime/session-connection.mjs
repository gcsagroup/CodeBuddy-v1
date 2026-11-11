// Delivery follows the loaded session. Harness and the journal retain task and
// persistence ownership when the submitting WebSocket disappears.
const decisionMethods = new Set(['session/request_permission', 'elicitation/create',
  '_goose/unstable/session/recipe/request-params']);

export function clientDisconnectedError() {
  return Object.assign(new Error('界面连接已断开；任务仍在后台执行，重新连接后可恢复查看和处理。'), {
    code: 'ACP_CLIENT_DISCONNECTED',
  });
}

export function createSessionConnection({ sessionId, initial, observers, signal, onAttach }) {
  const clients = new Set([initial]);
  const changed = new Set();
  let closed = false;
  const current = () => [...clients].find(client => observers().has(client));
  const wake = () => { for (const callback of [...changed]) callback(); };
  const ready = requestSignal => new Promise((resolve, reject) => {
    const signals = new Set([signal, requestSignal].filter(Boolean));
    const cleanup = () => {
      changed.delete(finish);
      for (const item of signals) item.removeEventListener('abort', finish);
    };
    const finish = () => {
      const aborted = [...signals].find(item => item.aborted);
      if (closed || aborted) {
        cleanup(); reject(aborted?.reason ?? new DOMException('任务已停止。', 'AbortError'));
      } else if (current()) { cleanup(); resolve(current()); }
    };
    changed.add(finish);
    for (const item of signals) item.addEventListener('abort', finish, { once: true });
    finish();
  });
  const connection = {
    background: false,
    notify(method, params) {
      for (const client of observers()) {
        if (client.background || !client.sessionIds?.has(sessionId)) continue;
        try { client.notify(method, params); }
        catch { /* Display delivery cannot cancel or overwrite task facts. */ }
      }
    },
    async ask(method, params, requestSignal = signal) {
      // Human choices can be presented again; browser/desktop operations with
      // uncertain side effects must never be replayed by the transport.
      const repeatable = decisionMethods.has(method);
      for (;;) {
        requestSignal?.throwIfAborted();
        let client = current();
        if (!client) {
          if (!repeatable) throw clientDisconnectedError();
          client = await ready(requestSignal);
        }
        try {
          onAttach?.(connection, client);
          return await client.ask(method, params, requestSignal);
        } catch (error) {
          if (!repeatable || error?.code !== 'ACP_CLIENT_DISCONNECTED' || requestSignal?.aborted) throw error;
          clients.delete(client);
        }
      }
    },
    attach(client) {
      if (closed || client.background) return;
      clients.add(client); wake();
    },
    detach(client) { clients.delete(client); wake(); },
    dispose() { closed = true; clients.clear(); wake(); changed.clear(); },
  };
  onAttach?.(connection, initial);
  return connection;
}
