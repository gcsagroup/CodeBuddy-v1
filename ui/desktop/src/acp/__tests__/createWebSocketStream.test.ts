import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientSideConnection } from '@agentclientprotocol/sdk';
import { AcpTransportError, createWebSocketStream } from '../createWebSocketStream';

class FakeWebSocket extends window.EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    fakeWebSockets.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
    this.close();
  }
}

const fakeWebSockets: FakeWebSocket[] = [];

function latestWebSocket(): FakeWebSocket {
  const ws = fakeWebSockets[fakeWebSockets.length - 1];
  if (!ws) {
    throw new Error('Expected a WebSocket to be created');
  }
  return ws;
}

function testRequest() {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'test',
  };
}

describe('createWebSocketStream', () => {
  beforeEach(() => {
    fakeWebSockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for the socket to open before sending JSON', async () => {
    const stream = createWebSocketStream('ws://localhost/acp');
    const writer = stream.writable.getWriter();
    const write = writer.write(testRequest());
    const ws = latestWebSocket();

    expect(ws.sent).toEqual([]);

    ws.open();
    await write;

    expect(ws.sent).toEqual(['{"jsonrpc":"2.0","id":1,"method":"test"}']);
  });

  it('closes an idle readable stream with a stable not-sent transport error', async () => {
    const stream = createWebSocketStream('ws://localhost/acp');
    const reader = stream.readable.getReader();
    const ws = latestWebSocket();

    ws.open();
    ws.close();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'AcpTransportError',
      code: 'ACP_TRANSPORT_NOT_SENT',
      dispatchState: 'not_sent',
    });
  });

  it.each([
    {
      event: 'closes',
      trigger: (ws: FakeWebSocket) => ws.close(),
      error: 'ACP WebSocket closed before connection opened',
    },
    {
      event: 'errors',
      trigger: (ws: FakeWebSocket) => ws.fail(),
      error: 'ACP WebSocket connection failed',
    },
  ])(
    'rejects a pending write when the socket $event before opening',
    async ({ trigger, error }) => {
      const stream = createWebSocketStream('ws://localhost/acp');
      const writer = stream.writable.getWriter();
      const write = writer.write(testRequest());

      trigger(latestWebSocket());

      await expect(write).rejects.toMatchObject({
        name: 'AcpTransportError',
        code: 'ACP_TRANSPORT_NOT_SENT',
        dispatchState: 'not_sent',
        message: error,
      });
    }
  );

  it('rejects a write when the socket has closed', async () => {
    const stream = createWebSocketStream('ws://localhost/acp');
    const writer = stream.writable.getWriter();
    const ws = latestWebSocket();

    ws.open();
    ws.close();

    await expect(writer.write(testRequest())).rejects.toMatchObject({
      name: 'AcpTransportError',
      code: 'ACP_TRANSPORT_NOT_SENT',
      dispatchState: 'not_sent',
      message: 'ACP WebSocket connection lost',
    });
  });

  it('propagates submission-unknown through a real pending ACP request', async () => {
    const stream = createWebSocketStream('ws://localhost/acp');
    const connection = new ClientSideConnection(() => ({}) as never, stream);
    const ws = latestWebSocket();
    const pending = connection.extMethod('test/pending', {});

    ws.open();
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    ws.close();

    await expect(pending).rejects.toBeInstanceOf(AcpTransportError);
    await expect(pending).rejects.toMatchObject({
      code: 'ACP_TRANSPORT_SUBMISSION_UNKNOWN',
      dispatchState: 'unknown',
      message: 'ACP WebSocket connection lost',
    });
  });

  it('propagates not-sent when an ACP request loses the socket before dispatch', async () => {
    const stream = createWebSocketStream('ws://localhost/acp');
    const connection = new ClientSideConnection(() => ({}) as never, stream);
    const pending = connection.extMethod('test/not-sent', {});

    latestWebSocket().close();

    await expect(pending).rejects.toBeInstanceOf(AcpTransportError);
    await expect(pending).rejects.toMatchObject({
      code: 'ACP_TRANSPORT_NOT_SENT',
      dispatchState: 'not_sent',
      message: 'ACP WebSocket closed before connection opened',
    });
  });
});
