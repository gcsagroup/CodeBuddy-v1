import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppEvents } from '../../constants/events';
import { ChatState } from '../../types/chatState';
import type { Session } from '../../types/session';
import { maybeHandlePlatformEvent } from '../../utils/platform_events';
import {
  handleAcpSessionNotification,
  handleAcpGooseSessionNotification,
} from '../chatNotifications';
import {
  expireAcpPermissionRequestForTool,
  expireAcpPermissionRequestsForTurn,
} from '../permissionRequests';
import type { AcpChatSessionSnapshot } from '../chatSessionStore';
import { acpChatSessionActions, acpChatSessionStore } from '../chatSessionStore';

vi.mock('../chatSessionStore', () => ({
  acpChatSessionStore: {
    getSnapshot: vi.fn(),
  },
  acpChatSessionActions: {
    applyAcpSessionNotification: vi.fn(),
    applyAcpGooseSessionNotification: vi.fn(),
  },
}));

vi.mock('../../utils/platform_events', () => ({
  maybeHandlePlatformEvent: vi.fn(),
}));

vi.mock('../permissionRequests', () => ({
  expireAcpPermissionRequestForTool: vi.fn(),
  expireAcpPermissionRequestsForTurn: vi.fn(),
}));

const SESSION_ID = 'session-1';

function sessionInfoUpdate(title: string): SessionNotification {
  return {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: 'session_info_update',
      title,
    },
  };
}

function platformEventToolUpdate(status: 'in_progress' | 'completed'): SessionNotification {
  return {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status,
      _meta: {
        toolNotification: {
          type: 'platform_event',
          params: {
            extension: 'apps',
            event_type: 'app_created',
            app_name: 'platform-event-repro',
          },
        },
      },
    },
  };
}

function sessionWithName(name: string): Session {
  return {
    id: SESSION_ID,
    name,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    working_dir: '/tmp',
    message_count: 0,
    extension_data: {},
    source: 'test',
  } as Session;
}

function snapshotWithName(name: string): AcpChatSessionSnapshot {
  return {
    session: sessionWithName(name),
    messages: [],
    tokenState: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      accumulatedInputTokens: 0,
      accumulatedOutputTokens: 0,
      accumulatedTotalTokens: 0,
    },
    notifications: [],
    progressMessage: undefined,
    chatState: ChatState.Idle,
    sessionLoadError: undefined,
    promptError: undefined,
    activePromptAttemptId: null,
    activeRunId: null,
    pendingCancelPromptAttemptId: null,
  };
}

function snapshotWithoutSession(): AcpChatSessionSnapshot {
  return {
    session: undefined,
    messages: [],
    tokenState: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      accumulatedInputTokens: 0,
      accumulatedOutputTokens: 0,
      accumulatedTotalTokens: 0,
    },
    notifications: [],
    progressMessage: undefined,
    chatState: ChatState.Idle,
    sessionLoadError: undefined,
    promptError: undefined,
    activePromptAttemptId: null,
    activeRunId: null,
    pendingCancelPromptAttemptId: null,
  };
}

describe('handleAcpSessionNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches SESSION_RENAMED when a session info notification changes the name', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValueOnce(snapshotWithName('Old name'));
    vi.mocked(acpChatSessionActions.applyAcpSessionNotification).mockReturnValueOnce(
      snapshotWithName('New name')
    );

    await handleAcpSessionNotification(sessionInfoUpdate('New name'));

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AppEvents.SESSION_RENAMED,
        detail: { sessionId: SESSION_ID, newName: 'New name' },
      })
    );
  });

  it('does not dispatch SESSION_RENAMED when the name is unchanged', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValueOnce(snapshotWithName('Same name'));
    vi.mocked(acpChatSessionActions.applyAcpSessionNotification).mockReturnValueOnce(
      snapshotWithName('Same name')
    );

    await handleAcpSessionNotification(sessionInfoUpdate('Same name'));

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('dispatches SESSION_RENAMED from the notification title when the session is not loaded', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValueOnce(snapshotWithoutSession());
    vi.mocked(acpChatSessionActions.applyAcpSessionNotification).mockReturnValueOnce(
      snapshotWithoutSession()
    );

    await handleAcpSessionNotification(sessionInfoUpdate('Generated name'));

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AppEvents.SESSION_RENAMED,
        detail: { sessionId: SESSION_ID, newName: 'Generated name' },
      })
    );
  });

  it('forwards live ACP platform events to the desktop platform event handler', async () => {
    await handleAcpSessionNotification(platformEventToolUpdate('in_progress'));

    expect(maybeHandlePlatformEvent).toHaveBeenCalledWith(
      {
        method: 'platform_event',
        params: {
          extension: 'apps',
          event_type: 'app_created',
          app_name: 'platform-event-repro',
        },
      },
      SESSION_ID
    );
  });

  it('does not forward completed platform event metadata as a live desktop event', async () => {
    await handleAcpSessionNotification(platformEventToolUpdate('completed'));

    expect(maybeHandlePlatformEvent).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)(
    'expires a permission on a real %s tool receipt',
    async (status) => {
      await handleAcpSessionNotification({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status,
        },
      });
      expect(expireAcpPermissionRequestForTool).toHaveBeenCalledWith(SESSION_ID, 'tool-1');
    }
  );

  it('does not expire permission from tool progress', async () => {
    await handleAcpSessionNotification(platformEventToolUpdate('in_progress'));
    expect(expireAcpPermissionRequestForTool).not.toHaveBeenCalled();
  });
});

function progress(data: unknown): GooseSessionNotification_unstable {
  return {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: 'status_message',
      status: { type: 'progress', message: 'receipt', data },
    },
  } as GooseSessionNotification_unstable;
}

const childToolReceipt = {
  schema_version: 1,
  event_id: 'receipt-1',
  tool_call_id: 'child-session:call-1',
  event_type: 'tool_completed',
  session_id: SESSION_ID,
  run_id: 'run-1',
  task_id: null,
  parent_task_id: null,
  agent_role: null,
  effective_model: null,
  status: 'failed',
  started_at: '2026-10-16T00:00:00Z',
  finished_at: '2026-10-16T00:00:01Z',
  title: 'native child result',
  technical_details: null,
  path: null,
  command_summary: null,
  exit_code: null,
  diff_summary: null,
  include_in_model_context: false,
  retryable: false,
  retry_from_event_id: null,
};

describe('permission lifecycle from Goose structured notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('expires child permissions delivered as activity receipts rather than ACP tool updates', async () => {
    await handleAcpGooseSessionNotification(progress(childToolReceipt));
    expect(expireAcpPermissionRequestForTool).toHaveBeenCalledExactlyOnceWith(
      SESSION_ID,
      'child-session:call-1',
      'run-1',
      true
    );
  });

  it.each([
    { status: 'running', event_type: 'tool_started' },
    { status: 'unknown' },
    { tool_call_id: undefined },
    { session_id: 'other-session' },
    { schema_version: 999 },
    { event_type: 'run_completed' },
  ])('does not expire a request from incomplete or unrelated activity %j', async (change) => {
    await handleAcpGooseSessionNotification(progress({ ...childToolReceipt, ...change }));
    expect(expireAcpPermissionRequestForTool).not.toHaveBeenCalled();
  });

  it('passes both run and source identity when the authoritative turn ends', async () => {
    await handleAcpGooseSessionNotification(
      progress({
        schema_version: 1,
        session_id: SESSION_ID,
        run_id: 'run-1',
        terminal_message_id: 'terminal-1',
        source_user_message_id: 'user-1',
        status: 'completed',
        checkpoint_id: null,
        retry_strategy: 'not_available',
        visible_text_available: true,
        tool_action_count: 3,
        copy_artifact_ref: null,
        finished_at: '2026-10-16T00:00:01Z',
      })
    );
    expect(expireAcpPermissionRequestsForTurn).toHaveBeenCalledExactlyOnceWith(
      SESSION_ID,
      'run-1',
      'user-1'
    );
  });

  it('does not expire a request from plain completion prose', async () => {
    await handleAcpGooseSessionNotification(progress({ message: 'finished', status: 'completed' }));
    expect(expireAcpPermissionRequestForTool).not.toHaveBeenCalled();
    expect(expireAcpPermissionRequestsForTurn).not.toHaveBeenCalled();
  });
});
