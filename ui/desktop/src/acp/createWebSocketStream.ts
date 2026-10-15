import type { Stream } from '@aaif/goose-sdk';

export type ClosableAcpStream = Stream & {
  close: () => void;
};

export type AcpTransportDispatchState = 'not_sent' | 'unknown';

export class AcpTransportError extends Error {
  readonly code: 'ACP_TRANSPORT_NOT_SENT' | 'ACP_TRANSPORT_SUBMISSION_UNKNOWN';

  constructor(
    message: string,
    readonly dispatchState: AcpTransportDispatchState
  ) {
    super(message);
    this.name = 'AcpTransportError';
    this.code =
      dispatchState === 'unknown' ? 'ACP_TRANSPORT_SUBMISSION_UNKNOWN' : 'ACP_TRANSPORT_NOT_SENT';
  }
}

export function createWebSocketStream(wsUrl: string): ClosableAcpStream {
  const ws = new window.WebSocket(wsUrl);

  const incoming: unknown[] = [];
  const waiters: Array<() => void> = [];
  const pendingRequestIds = new Set<string | number>();
  let closed = false;
  let opened = false;
  let transportError: AcpTransportError | null = null;

  function requestId(message: unknown): string | number | null {
    if (typeof message !== 'object' || message === null || !('id' in message)) return null;
    const id = (message as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  }

  function isRequest(message: unknown): boolean {
    return typeof message === 'object' && message !== null && 'method' in message;
  }

  function pushMessage(message: unknown): void {
    const id = requestId(message);
    if (id !== null && !isRequest(message)) {
      pendingRequestIds.delete(id);
    }
    incoming.push(message);
    waiters.shift()?.();
  }

  function waitForMessage(): Promise<void> {
    if (incoming.length > 0 || closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  }

  let resolveOpen!: () => void;
  let rejectOpen!: (error: AcpTransportError) => void;
  const openPromise = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  ws.addEventListener(
    'open',
    () => {
      opened = true;
      resolveOpen();
    },
    { once: true }
  );

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      return;
    }
    try {
      pushMessage(JSON.parse(event.data));
    } catch {
      // Ignore malformed messages from the transport.
    }
  });

  const closeWaiters = (message: string) => {
    if (closed) return;
    closed = true;
    transportError = new AcpTransportError(
      message,
      pendingRequestIds.size > 0 ? 'unknown' : 'not_sent'
    );
    rejectOpen(transportError);
    for (const waiter of waiters) {
      waiter();
    }
    waiters.length = 0;
  };

  ws.addEventListener('close', () =>
    closeWaiters(
      opened ? 'ACP WebSocket connection lost' : 'ACP WebSocket closed before connection opened'
    )
  );
  ws.addEventListener('error', () =>
    closeWaiters(opened ? 'ACP WebSocket connection lost' : 'ACP WebSocket connection failed')
  );

  const readable = new window.ReadableStream({
    async pull(controller) {
      await waitForMessage();
      while (incoming.length > 0) {
        controller.enqueue(incoming.shift());
      }
      if (closed && incoming.length === 0) {
        controller.error(transportError);
      }
    },
  });

  const writable = new window.WritableStream({
    async write(message) {
      await openPromise;
      if (closed || ws.readyState !== window.WebSocket.OPEN) {
        throw new AcpTransportError('ACP WebSocket connection lost', 'not_sent');
      }
      const serialized = JSON.stringify(message);
      try {
        ws.send(serialized);
      } catch {
        throw new AcpTransportError('ACP WebSocket connection lost', 'not_sent');
      }
      const id = requestId(message);
      if (id !== null && isRequest(message)) {
        pendingRequestIds.add(id);
      }
    },
    close() {
      ws.close();
    },
    abort() {
      ws.close();
    },
  });

  return {
    readable,
    writable,
    close: () => ws.close(),
  } as ClosableAcpStream;
}
