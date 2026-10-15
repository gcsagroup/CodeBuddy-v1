import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAcpPermissionRequestsForSession,
  requestAcpPermission,
  resolveAcpPermissionRequest,
  restoreAcpPermissionRequestsForSession,
  expireAcpPermissionRequestForTool,
  expireAcpPermissionRequestsForTurn,
  isAcpPermissionRequestPending,
  subscribeAcpPermissionRequests,
} from '../permissionRequests';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  type AcpChatSessionSnapshot,
} from '../chatSessionStore';

vi.mock('../chatSessionStore', () => ({
  acpChatSessionStore: {
    getSnapshot: vi.fn(),
    getActivePromptSourceUserMessageId: vi.fn(() => 'user-1'),
  },
  acpPermissionUserInputRequestId: (toolCallId: string) => `permission:${toolCallId}`,
  acpChatSessionActions: {
    applyPermissionRequest: vi.fn(),
    resolveUserInputRequest: vi.fn(),
  },
}));

function permissionRequest(sessionId: string, toolCallId: string): RequestPermissionRequest {
  return {
    sessionId,
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Deny once', kind: 'reject_once' },
    ],
    toolCall: {
      toolCallId,
      title: 'Read file',
      rawInput: { path: 'README.md' },
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Allow reading README.md?' },
        },
      ],
    },
  };
}

const TEST_SESSION_IDS = ['session-1', 'session-2'];

async function expectStillPending(promise: Promise<RequestPermissionResponse>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  await Promise.resolve();

  expect(settled).toBe(false);
}

describe('ACP permission requests', () => {
  it('restores only unanswered requests for the loaded session without granting permission', async () => {
    const request = permissionRequest('session-1', 'tool-1');
    const response = requestAcpPermission(request);
    const other = requestAcpPermission(permissionRequest('session-2', 'tool-2'));
    vi.mocked(acpChatSessionActions.applyPermissionRequest).mockClear();
    restoreAcpPermissionRequestsForSession('session-1');
    expect(acpChatSessionActions.applyPermissionRequest).toHaveBeenCalledExactlyOnceWith(request);
    await expectStillPending(response);
    await expectStillPending(other);
    resolveAcpPermissionRequest('session-1', 'tool-1', 'deny_once');
    await response;
    vi.mocked(acpChatSessionActions.applyPermissionRequest).mockClear();
    restoreAcpPermissionRequestsForSession('session-1');
    expect(acpChatSessionActions.applyPermissionRequest).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(undefined);
    vi.mocked(acpChatSessionStore.getActivePromptSourceUserMessageId).mockReturnValue('user-1');
    for (const sessionId of TEST_SESSION_IDS) {
      cancelAcpPermissionRequestsForSession(sessionId);
    }
  });

  afterEach(() => {
    for (const sessionId of TEST_SESSION_IDS) {
      cancelAcpPermissionRequestsForSession(sessionId);
    }
  });

  it('keeps permission requests pending until explicit resolve', async () => {
    const response = requestAcpPermission(permissionRequest('session-1', 'tool-1'));

    await expectStillPending(response);

    expect(resolveAcpPermissionRequest('session-1', 'tool-1', 'allow_once')).toBe(true);
    expect(acpChatSessionActions.resolveUserInputRequest).toHaveBeenCalledWith(
      'session-1',
      'permission:tool-1'
    );
    await expect(response).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once',
      },
    });
  });

  it('cancels only pending requests for the requested session', async () => {
    const sessionOneResponse = requestAcpPermission(permissionRequest('session-1', 'tool-1'));
    const sessionTwoResponse = requestAcpPermission(permissionRequest('session-2', 'tool-2'));

    cancelAcpPermissionRequestsForSession('session-1');

    await expect(sessionOneResponse).resolves.toEqual({
      outcome: {
        outcome: 'cancelled',
      },
    });
    await expectStillPending(sessionTwoResponse);

    expect(resolveAcpPermissionRequest('session-2', 'tool-2', 'deny_once')).toBe(true);
    await expect(sessionTwoResponse).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'reject-once',
      },
    });
  });

  it('cancels an older duplicate request for the same session and tool call', async () => {
    const firstResponse = requestAcpPermission(permissionRequest('session-1', 'tool-1'));
    const secondResponse = requestAcpPermission(permissionRequest('session-1', 'tool-1'));

    await expect(firstResponse).resolves.toEqual({
      outcome: {
        outcome: 'cancelled',
      },
    });
    await expectStillPending(secondResponse);

    expect(resolveAcpPermissionRequest('session-1', 'tool-1', 'allow_once')).toBe(true);
    await expect(secondResponse).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once',
      },
    });
  });

  it('does not consume a pending request when the selected action is unavailable', async () => {
    const response = requestAcpPermission(permissionRequest('session-1', 'tool-1'));

    expect(resolveAcpPermissionRequest('session-1', 'tool-1', 'always_allow')).toBe(false);
    await expectStillPending(response);

    expect(resolveAcpPermissionRequest('session-1', 'tool-1', 'allow_once')).toBe(true);
    await expect(response).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once',
      },
    });
  });

  it('notifies mounted cards and clears waiting input when the connection closes', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAcpPermissionRequests(listener);
    const controller = new AbortController();
    const response = requestAcpPermission(
      permissionRequest('session-1', 'tool-1'),
      controller.signal
    );
    expect(isAcpPermissionRequestPending('session-1', 'tool-1')).toBe(true);
    controller.abort();
    expect(isAcpPermissionRequestPending('session-1', 'tool-1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(acpChatSessionActions.resolveUserInputRequest).toHaveBeenCalledWith(
      'session-1',
      'permission:tool-1'
    );
    await expect(response).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    unsubscribe();
  });

  it('does not project a request for an already closed connection', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestAcpPermission(permissionRequest('session-1', 'tool-1'), controller.signal)
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(acpChatSessionActions.applyPermissionRequest).not.toHaveBeenCalled();
  });

  it('expires a child receipt by protocol call id without granting the unanswered request', async () => {
    const response = requestAcpPermission(permissionRequest('session-1', 'tool-1'));
    expireAcpPermissionRequestForTool('session-2', 'child:tool-1', 'run-1', true);
    await expectStillPending(response);
    expireAcpPermissionRequestForTool('session-1', 'child:tool-1', 'run-1', true);
    expect(isAcpPermissionRequestPending('session-1', 'tool-1')).toBe(false);
    expect(resolveAcpPermissionRequest('session-1', 'tool-1', 'allow_once')).toBe(false);
    await expect(response).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('keeps a newer turn permission live when an older terminal or receipt is replayed', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      activeRunId: 'run-2',
      messages: [],
    } as unknown as AcpChatSessionSnapshot);
    vi.mocked(acpChatSessionStore.getActivePromptSourceUserMessageId).mockReturnValue('user-2');
    const response = requestAcpPermission(permissionRequest('session-1', 'tool-1'));
    expireAcpPermissionRequestsForTurn('session-1', 'run-1', 'user-1');
    expireAcpPermissionRequestsForTurn('session-1', 'run-2', 'user-1');
    expireAcpPermissionRequestForTool('session-1', 'child:tool-1', 'run-1', true);
    await expectStillPending(response);
    expireAcpPermissionRequestsForTurn('session-1', 'run-2', 'user-2');
    await expect(response).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('preserves an exact tool id containing a colon when consuming a structured receipt', async () => {
    const response = requestAcpPermission(permissionRequest('session-1', 'native:tool-1'));
    expireAcpPermissionRequestForTool('session-1', 'native:tool-1', 'run-1', true);
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('removes an old connection abort listener when a request is replaced', async () => {
    const oldConnection = new AbortController();
    const first = requestAcpPermission(
      permissionRequest('session-1', 'tool-1'),
      oldConnection.signal
    );
    const second = requestAcpPermission(permissionRequest('session-1', 'tool-1'));
    await first;
    oldConnection.abort();
    await expectStillPending(second);
    expect(isAcpPermissionRequestPending('session-1', 'tool-1')).toBe(true);
  });

  function nativeToolSnapshot(
    name: string,
    extensionName = 'harness',
    id = 'tool-1'
  ): AcpChatSessionSnapshot {
    return {
      activeRunId: 'run-1',
      messages: [
        {
          content: [
            {
              type: 'toolRequest',
              id,
              metadata: { extensionName },
              toolCall: { status: 'success', value: { name, arguments: {} } },
            },
          ],
          role: 'assistant',
          created: 1,
          metadata: { userVisible: true, agentVisible: true },
        },
      ],
    } as unknown as AcpChatSessionSnapshot;
  }

  it.each([
    'subagent',
    'subagent_planner',
    'subagent_coder',
    'subagent_tester',
    'subagent_reviewer',
  ])('allows only one invocation of verified native %s without showing a card', async (name) => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(nativeToolSnapshot(name));
    const request = permissionRequest('session-1', 'tool-1');
    request.toolCall.title = name;
    await expect(requestAcpPermission(request)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(acpChatSessionActions.applyPermissionRequest).not.toHaveBeenCalled();
    expect(isAcpPermissionRequestPending('session-1', 'tool-1')).toBe(false);
  });

  it.each([
    ['subagent', 'external_mcp', 'tool-1', 'subagent'],
    ['subagent', 'harness', 'other-call', 'subagent'],
    ['read', 'harness', 'tool-1', 'subagent'],
    ['read', 'harness', 'tool-1', 'read'],
    ['write', 'harness', 'tool-1', 'write'],
    ['pwsh', 'harness', 'tool-1', 'pwsh'],
    ['subagent_custom', 'harness', 'tool-1', 'subagent_custom'],
  ])(
    'keeps %s owned by %s pending when identity or operation is outside the spawn policy',
    async (name, owner, id, title) => {
      vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(
        nativeToolSnapshot(name, owner, id)
      );
      const request = permissionRequest('session-1', 'tool-1');
      request.toolCall.title = title;
      await expectStillPending(requestAcpPermission(request));
      expect(acpChatSessionActions.applyPermissionRequest).toHaveBeenCalledWith(request);
    }
  );

  it('does not choose persistent permission when native spawn offers no allow_once', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(nativeToolSnapshot('subagent'));
    const request = permissionRequest('session-1', 'tool-1');
    request.toolCall.title = 'subagent';
    request.options = [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }];
    await expectStillPending(requestAcpPermission(request));
  });
});
