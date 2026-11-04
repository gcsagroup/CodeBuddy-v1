import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { getAcpControlClient } from './acpConnection';
import {
  applySubagentViewNotification,
  readSubagentConversation,
  createSubagentConversationProjection,
  watchSubagentConversation,
} from './subagentConversation';
vi.mock('./acpConnection', () => ({ getAcpControlClient: vi.fn() }));
const extMethod = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAcpControlClient).mockResolvedValue({ extMethod } as unknown as Awaited<
    ReturnType<typeof getAcpControlClient>
  >);
});
const page = {
  sessionId: 'root',
  childSessionId: 'leaf',
  throughSeq: -1,
  hasMore: false,
  events: [],
};
it('preserves the old direct-child request while binding explicit catalog ancestry', async () => {
  extMethod.mockResolvedValueOnce(page);
  await expect(readSubagentConversation('root', 'leaf', -1)).resolves.toEqual(page);
  expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/subagent/conversation/get', {
    sessionId: 'root',
    childSessionId: 'leaf',
    afterSeq: -1,
  });
  extMethod.mockResolvedValueOnce({ ...page, ancestorSessionIds: ['a'] });
  await readSubagentConversation('root', 'leaf', -1, ['a']);
  expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/subagent/conversation/get', {
    sessionId: 'root',
    childSessionId: 'leaf',
    afterSeq: -1,
    ancestorSessionIds: ['a'],
  });
});
it('rejects a mismatched ancestry instead of displaying a neighboring child response', async () => {
  extMethod.mockResolvedValueOnce({ ...page, ancestorSessionIds: ['other'] });
  await expect(readSubagentConversation('root', 'leaf', -1, ['a'])).rejects.toThrow(
    'Invalid subagent conversation response'
  );
});

it('binds live frames to the exact subscription and root, reconnects only its observer, and unsubscribes on close', async () => {
  vi.useFakeTimers();
  extMethod.mockResolvedValue({});
  const receive = vi.fn(),
    connection = new AbortController();
  const close = watchSubagentConversation('root', 'leaf', ['ancestor'], receive);
  try {
    await Promise.resolve();
    const [method, params] = extMethod.mock.calls[0];
    expect(method).toBe('_goose/unstable/subagent/conversation/follow');
    expect(params).toMatchObject({
      sessionId: 'root',
      childSessionId: 'leaf',
      ancestorSessionIds: ['ancestor'],
    });
    const notification = (sessionId: string, childSessionId: string): SessionNotification => ({
      sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          'codebuddy/subagent-view': {
            subscriptionId: params.subscriptionId,
            childSessionId,
            type: 'ready',
            events: [],
          },
        },
      },
    });
    applySubagentViewNotification(notification('other', 'leaf'), connection.signal);
    applySubagentViewNotification(notification('root', 'other'), connection.signal);
    expect(receive).not.toHaveBeenCalled();
    applySubagentViewNotification(notification('root', 'leaf'), connection.signal);
    expect(receive).toHaveBeenCalledTimes(1);
    connection.abort();
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(extMethod.mock.calls.filter(([method]) => method.endsWith('/follow'))).toHaveLength(2);
    close();
    await Promise.resolve();
    expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/subagent/conversation/unfollow', {
      subscriptionId: params.subscriptionId,
    });
    const count = receive.mock.calls.length;
    applySubagentViewNotification(notification('root', 'leaf'));
    expect(receive).toHaveBeenCalledTimes(count);
    expect(extMethod.mock.calls.every(([method]) => method.includes('/conversation/'))).toBe(true);
  } finally {
    close();
    vi.useRealTimers();
  }
});

it('projects a child output-limit exit without showing an open or unknown turn, and accepts a later restart', () => {
  const projection = createSubagentConversationProjection('child');
  projection.append([
    { seq: 1, type: 'turn/start', time: 1000, data: { turn: 1 } },
    { seq: 2, type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'max-tokens' } } },
  ]);
  expect(projection.status).toBe('limited');
  projection.append([{ seq: 3, type: 'turn/start', time: 3000, data: { turn: 2 } }]);
  expect(projection.status).toBe('running');
  projection.append([
    {
      seq: 4,
      type: 'turn/end',
      time: 4000,
      data: {
        turn: 2,
        reason: { kind: 'completed' },
      },
    },
  ]);
  expect(projection.status).toBe('completed');
});

it.each([
  'OUTPUT_LIMIT_REACHED',
  'OUTPUT_TRUNCATED',
  'OUTPUT_LENGTH_STOP',
  'LOCAL_OUTPUT_BUDGET_EXHAUSTED',
])('uses native %s to mark a settled child as limited', (code) => {
  const projection = createSubagentConversationProjection('child');
  projection.append([
    { seq: 1, type: 'turn/start', time: 1, data: { turn: 1 } },
    {
      seq: 2,
      type: 'turn/end',
      time: 2,
      data: { turn: 1, reason: { kind: 'error', error: { code, message: 'fixture' } } },
    },
  ]);
  expect(projection.status).toBe('limited');
});
