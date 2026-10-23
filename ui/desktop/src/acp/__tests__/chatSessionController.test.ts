import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types/message';
import { ChatState } from '../../types/chatState';
import type { Session } from '../../types/session';
import { acpChatSessionController } from '../chatSessionController';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  subscribeToAcpChatSession,
  type AcpChatSessionSnapshot,
} from '../chatSessionStore';
import { acpCancelPrompt, acpPromptSession } from '../prompt';
import { cancelAcpElicitationRequestsForSession } from '../elicitationRequests';
import {
  cancelAcpPermissionRequestsForSession,
  restoreAcpPermissionRequestsForSession,
} from '../permissionRequests';
import {
  CodeProWorkspaceReconfirmationRequiredError,
  resumeCodeProSession,
} from '../../codepro/resumeCodeProSession';
import { acquireWorkspaceLease, releaseWorkspaceLease } from '../workspaceLease';
import { isAcpRecovering } from '../acpConnection';
import {
  acpForkSession,
  acpLoadSession,
  acpTruncateSessionConversation,
  isAcpSessionLoadInFlight,
  sessionInfoToSession,
} from '../sessions';

vi.mock('../../utils/extensionErrorUtils', () => ({
  showExtensionLoadResults: vi.fn(),
}));

vi.mock('../chatSessionStore', () => ({
  subscribeToAcpChatSession: vi.fn(() => () => undefined),
  acpChatSessionStore: {
    getSnapshot: vi.fn(),
  },
  acpChatSessionActions: {
    startSessionLoad: vi.fn(),
    finishSessionLoad: vi.fn(),
    failSessionLoad: vi.fn(),
    requireWorkspaceReconfirmation: vi.fn(),
    startPromptRequest: vi.fn(() => true),
    finishPromptRequest: vi.fn(),
    startPromptAttempt: vi.fn(),
    finishPromptAttemptIfCurrent: vi.fn(),
    isCurrentPromptAttempt: vi.fn(),
    setMessages: vi.fn(),
    addPendingLocalSteerMessage: vi.fn(),
    clearActivePromptAttempt: vi.fn(),
    startPromptCancellation: vi.fn(),
    clearPromptCancellation: vi.fn(),
    restorePromptCancellation: vi.fn(),
    waitForPromptCancellation: vi.fn(),
    setChatState: vi.fn(),
    setSessionMetadata: vi.fn(),
    setSessionLoadError: vi.fn(),
    clearPromptError: vi.fn(),
  },
}));

vi.mock('../sessions', () => ({
  acpLoadSession: vi.fn(),
  isAcpSessionLoadInFlight: vi.fn(),
  sessionInfoToSession: vi.fn(),
  acpForkSession: vi.fn(),
  acpTruncateSessionConversation: vi.fn(),
}));

vi.mock('../../codepro/resumeCodeProSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../codepro/resumeCodeProSession')>()),
  resumeCodeProSession: vi.fn(),
}));

vi.mock('../workspaceLease', () => ({
  acquireWorkspaceLease: vi.fn(),
  releaseWorkspaceLease: vi.fn(),
}));

vi.mock('../prompt', () => ({
  acpCancelPrompt: vi.fn(),
  acpPromptSession: vi.fn(),
}));

vi.mock('../acpConnection', () => ({
  isAcpRecovering: vi.fn(),
}));

vi.mock('../elicitationRequests', () => ({
  cancelAcpElicitationRequestsForSession: vi.fn(),
}));

vi.mock('../permissionRequests', () => ({
  cancelAcpPermissionRequestsForSession: vi.fn(),
  restoreAcpPermissionRequestsForSession: vi.fn(),
}));

const SESSION_ID = 'session-1';

function userMessage(): Message & { id: string } {
  return {
    id: 'message-1',
    role: 'user',
    created: 123,
    content: [{ type: 'text', text: 'Hello' }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

function checkpointMessage(
  index: number,
  recoveryAction: 'continue_checkpoint' | 'ask_user' = 'continue_checkpoint'
): Message & { id: string } {
  const id = `checkpoint-message-${index}`;
  return {
    id,
    role: 'assistant',
    created: 123 + index,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: 'Paused with checkpoint',
        data: {
          schema_version: 1,
          session_id: SESSION_ID,
          run_id: `run-${index}`,
          terminal_message_id: id,
          source_user_message_id: 'message-1',
          status: 'interrupted',
          checkpoint_id: `checkpoint-${index}`,
          retry_strategy: 'continue_checkpoint',
          visible_text_available: true,
          tool_action_count: 2,
          copy_artifact_ref: null,
          finished_at: `2026-08-20T12:00:0${index}.000Z`,
          report: {
            outcome: recoveryAction === 'ask_user' ? 'waiting_for_user' : 'paused',
            classification_counts: {
              confirmed_bug: 0,
              test_failure: 0,
              environment_problem: 1,
              codepro_incomplete: 1,
              unverified: 0,
            },
            changed_files: [],
            verification_summary: [],
            limitations: [],
            recovery_action: recoveryAction,
          },
        },
      },
    ],
    metadata: { userVisible: true, agentVisible: true },
  };
}

function loadedSession(): Session {
  return {
    id: SESSION_ID,
    name: 'Loaded session',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    working_dir: '/tmp',
    message_count: 0,
    extension_data: {},
    source: 'test',
  } as Session;
}

function mockLoadResult() {
  return {
    sessionInfo: {
      sessionId: SESSION_ID,
      cwd: '/tmp',
      title: 'Loaded session',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    response: {},
    meta: {},
  } as Awaited<ReturnType<typeof acpLoadSession>>;
}

function snapshotWithActivePrompt(activePromptAttemptId: string | null): AcpChatSessionSnapshot {
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
    chatState: activePromptAttemptId ? ChatState.Streaming : ChatState.Idle,
    sessionLoadError: undefined,
    promptError: undefined,
    activePromptAttemptId,
    activeRunId: activePromptAttemptId ? 'run-1' : null,
    pendingCancelPromptAttemptId: null,
  };
}

function pendingToolPermissionMessage(): Message & { id: string } {
  return {
    id: 'permission-message-1',
    role: 'assistant',
    created: 124,
    content: [
      {
        type: 'toolConfirmationRequest',
        id: 'tool-call-1',
        toolName: 'developer__shell',
        arguments: {},
        prompt: null,
      },
    ],
    metadata: { userVisible: true, agentVisible: true },
  };
}

describe('acpChatSessionController.loadSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(undefined);
    vi.mocked(acpLoadSession).mockResolvedValue(mockLoadResult());
    vi.mocked(sessionInfoToSession).mockReturnValue(loadedSession());
  });

  it('starts a fresh session load before ACP replays notifications', async () => {
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);

    await acpChatSessionController.loadSession(SESSION_ID);

    expect(acpChatSessionActions.startSessionLoad).toHaveBeenCalledWith(SESSION_ID);
    expect(acpLoadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(restoreAcpPermissionRequestsForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(
      vi.mocked(restoreAcpPermissionRequestsForSession).mock.invocationCallOrder[0]
    ).toBeGreaterThan(
      vi.mocked(acpChatSessionActions.finishSessionLoad).mock.invocationCallOrder[0]
    );
    expect(acpChatSessionActions.finishSessionLoad).toHaveBeenCalledWith(
      SESSION_ID,
      loadedSession()
    );
  });

  it('does not reset replay state when joining an in-flight session load', async () => {
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(true);

    await acpChatSessionController.loadSession(SESSION_ID);

    expect(acpChatSessionActions.startSessionLoad).not.toHaveBeenCalled();
    expect(acpLoadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(acpChatSessionActions.finishSessionLoad).toHaveBeenCalledWith(
      SESSION_ID,
      loadedSession()
    );
  });

  it('restores a cached session from the server', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
    });
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);

    await acpChatSessionController.restoreSession(SESSION_ID);

    expect(acpChatSessionActions.startSessionLoad).toHaveBeenCalledWith(SESSION_ID);
    expect(acpLoadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(acpChatSessionActions.finishSessionLoad).toHaveBeenCalledWith(
      SESSION_ID,
      loadedSession()
    );
  });

  it('retries a transient ACP disconnect without showing a fatal load error', async () => {
    vi.useFakeTimers();
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);
    vi.mocked(acpLoadSession)
      .mockRejectedValueOnce(new Error('ACP connection closed'))
      .mockResolvedValueOnce(mockLoadResult());

    const loadPromise = acpChatSessionController.loadSession(SESSION_ID);
    await vi.runAllTimersAsync();
    await loadPromise;

    expect(acpLoadSession).toHaveBeenCalledTimes(2);
    expect(acpChatSessionActions.startSessionLoad).toHaveBeenCalledTimes(2);
    expect(acpChatSessionActions.failSessionLoad).not.toHaveBeenCalled();
    expect(acpChatSessionActions.finishSessionLoad).toHaveBeenCalledWith(
      SESSION_ID,
      loadedSession()
    );
    vi.useRealTimers();
  });

  it('stops retrying and reports a persistent ACP disconnect', async () => {
    vi.useFakeTimers();
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);
    vi.mocked(acpLoadSession).mockRejectedValue(new Error('ACP connection closed'));

    const loadPromise = acpChatSessionController.loadSession(SESSION_ID);
    await vi.runAllTimersAsync();
    await loadPromise;

    expect(acpLoadSession).toHaveBeenCalledTimes(3);
    expect(acpChatSessionActions.failSessionLoad).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('surfaces CodePro workspace re-confirmation as structured state instead of a fatal load error', async () => {
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);
    vi.mocked(acpLoadSession).mockRejectedValue(
      new CodeProWorkspaceReconfirmationRequiredError({
        sessionId: SESSION_ID,
        workingDir: 'D:\\Projects\\Ledger',
      })
    );

    await acpChatSessionController.loadSession(SESSION_ID);

    expect(acpChatSessionActions.requireWorkspaceReconfirmation).toHaveBeenCalledWith(SESSION_ID, {
      sessionId: SESSION_ID,
      workingDir: 'D:\\Projects\\Ledger',
    });
    expect(acpChatSessionActions.failSessionLoad).not.toHaveBeenCalled();
  });
});

describe('acpChatSessionController.reconfirmCodeProWorkspace', () => {
  it('runs the fresh-lease resume contract and finishes the same session load', async () => {
    const candidate = {
      requestedPath: 'D:\\Projects\\Ledger',
      normalizedPath: 'D:\\Projects\\Ledger',
      normalizedIdentity: 'd:\\projects\\ledger',
      canonicalPath: 'D:\\Projects\\Ledger',
      source: 'prompt' as const,
      state: 'non-empty-directory' as const,
      isGitRepository: true,
      displayName: 'Ledger',
      suggestedProjectId: 'ledger-a1b2c3d4e5f6',
      error: null,
    };
    vi.mocked(acpLoadSession).mockResolvedValue(mockLoadResult());
    vi.mocked(sessionInfoToSession).mockReturnValue(loadedSession());
    vi.mocked(resumeCodeProSession).mockImplementation(async (input, dependencies) => {
      await dependencies.loadSession(input.sessionId, {
        cwd: candidate.normalizedPath,
        workspaceLeaseId: 'fresh-lease',
      });
    });

    await acpChatSessionController.reconfirmCodeProWorkspace(
      { sessionId: SESSION_ID, workingDir: candidate.normalizedPath },
      candidate
    );

    expect(resumeCodeProSession).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, candidate },
      expect.objectContaining({
        acquireWorkspaceLease,
        releaseWorkspaceLease,
      })
    );
    expect(acpLoadSession).toHaveBeenCalledWith(SESSION_ID, {
      cwd: candidate.normalizedPath,
      workspaceLeaseId: 'fresh-lease',
    });
    expect(acpChatSessionActions.finishSessionLoad).toHaveBeenCalledWith(
      SESSION_ID,
      loadedSession()
    );
  });
});

describe('acpChatSessionController.stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpCancelPrompt).mockResolvedValue(undefined);
  });

  it('marks cancellation pending while clearing visible prompt activity', () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(
      snapshotWithActivePrompt('attempt-1')
    );

    acpChatSessionController.stop(SESSION_ID);

    expect(acpChatSessionActions.startPromptCancellation).toHaveBeenCalledWith(
      SESSION_ID,
      'attempt-1'
    );
    expect(acpCancelPrompt).toHaveBeenCalledWith(SESSION_ID);
    expect(cancelAcpPermissionRequestsForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(cancelAcpElicitationRequestsForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(
      vi.mocked(cancelAcpPermissionRequestsForSession).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(acpChatSessionActions.startPromptCancellation).mock.invocationCallOrder[0]
    );
    expect(
      vi.mocked(cancelAcpElicitationRequestsForSession).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(acpChatSessionActions.startPromptCancellation).mock.invocationCallOrder[0]
    );
  });

  it('clears pending user requests even when no prompt attempt is active', () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(snapshotWithActivePrompt(null));

    acpChatSessionController.stop(SESSION_ID);

    expect(cancelAcpPermissionRequestsForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(cancelAcpElicitationRequestsForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(acpCancelPrompt).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setChatState).toHaveBeenCalledWith(SESSION_ID, ChatState.Idle);
  });

  it('keeps the cancellation barrier and reports a warning when ACP cancel fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(
      snapshotWithActivePrompt('attempt-failed-cancel')
    );
    vi.mocked(acpCancelPrompt).mockRejectedValueOnce(new Error('connection closed'));

    acpChatSessionController.stop(SESSION_ID);

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Failed to cancel ACP prompt:', expect.any(Error))
    );
    expect(acpChatSessionActions.startPromptCancellation).toHaveBeenCalledWith(
      SESSION_ID,
      'attempt-failed-cancel'
    );
    expect(acpChatSessionActions.setChatState).not.toHaveBeenCalledWith(SESSION_ID, ChatState.Idle);
    warn.mockRestore();
  });
});

describe('acpChatSessionController.submitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAcpRecovering).mockReturnValue(false);
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(snapshotWithActivePrompt(null));
    vi.mocked(acpPromptSession).mockResolvedValue({ stopReason: 'cancelled' } as never);
    vi.mocked(acpChatSessionActions.clearPromptCancellation).mockReturnValue(undefined);
    vi.mocked(acpChatSessionActions.finishPromptAttemptIfCurrent).mockReturnValue(true);
  });

  it('rejects another prompt locally while the prior RPC remains occupied after terminal display', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      ...snapshotWithActivePrompt(null),
      promptRequestId: 'still-settling',
    });
    const onRejectedBeforeAcceptance = vi.fn();
    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish: vi.fn(),
      onRejectedBeforeAcceptance,
    });
    expect(onRejectedBeforeAcceptance).toHaveBeenCalledOnce();
    expect(acpPromptSession).not.toHaveBeenCalled();
    expect(acpChatSessionActions.startPromptAttempt).not.toHaveBeenCalled();
  });

  it('measures the current first token once without logging content or depending on logger success', async () => {
    const previous = window.electron;
    const logInfo = vi.fn();
    window.electron = { ...previous, logInfo };
    let notifySnapshot: ((snapshot: AcpChatSessionSnapshot) => void) | undefined;
    vi.mocked(subscribeToAcpChatSession).mockImplementation((_sessionId, listener) => {
      notifySnapshot = listener;
      return () => undefined;
    });
    let finishPrompt: ((value: { stopReason: string }) => void) | undefined;
    vi.mocked(acpPromptSession).mockReturnValue(new Promise((resolve) => {
      finishPrompt = resolve;
    }) as never);
    const submittedAtMs = Date.now() - 500;
    const onAccepted = vi.fn();
    try {
      const submission = acpChatSessionController.submitMessage(SESSION_ID,
        { ...userMessage(), content: [{ type: 'text', text: 'PRIVATE-PROMPT' }] }, {
          getCurrentSnapshot: () => snapshotWithActivePrompt(null),
          onFinish: vi.fn(), onAccepted, submittedAtMs,
        });
      const attemptId = vi.mocked(acpChatSessionActions.startPromptAttempt).mock.calls[0][1];
      const pending = snapshotWithActivePrompt(attemptId);
      const activity = {
        promptAttemptId: attemptId, sourceUserMessageId: userMessage().id!,
        startedAt: submittedAtMs, receivedAt: submittedAtMs + 1234,
      };
      notifySnapshot?.({ ...pending, promptActivity: { ...activity, kind: 'tool' } });
      notifySnapshot?.({ ...pending, activePromptAttemptId: 'stale',
        promptActivity: { ...activity, kind: 'thought' } });
      notifySnapshot?.({ ...pending, promptActivity: { ...activity, kind: 'thought' } });
      notifySnapshot?.({ ...pending, promptActivity: { ...activity, kind: 'text' } });
      const records = logInfo.mock.calls.map(([line]) => JSON.parse(line));
      expect(records[0]).toMatchObject({ stage: 'prompt_submitted',
        submitted_at_ms: submittedAtMs, origin: 'composer' });
      expect(records.filter(record => record.stage === 'ui_first_token_received')).toEqual([
        expect.objectContaining({ elapsed_ms: 1234, kind: 'thought' }),
      ]);
      expect(JSON.stringify(records)).not.toContain('PRIVATE-PROMPT');
      logInfo.mockImplementation(() => { throw new Error('logger unavailable'); });
      notifySnapshot?.({ ...pending, activeRunId: 'run-1' });
      expect(onAccepted).toHaveBeenCalledOnce();
      finishPrompt?.({ stopReason: 'end_turn' });
      await submission;
    } finally {
      window.electron = previous;
    }
  });

  it('acknowledges the matching user echo before run startup without accepting unrelated history', async () => {
    let notifySnapshot: ((snapshot: AcpChatSessionSnapshot) => void) | undefined;
    vi.mocked(subscribeToAcpChatSession).mockImplementation((_sessionId, listener) => {
      notifySnapshot = listener;
      return () => undefined;
    });
    let finishPrompt: ((value: { stopReason: string }) => void) | undefined;
    vi.mocked(acpPromptSession).mockReturnValue(
      new Promise((resolve) => {
        finishPrompt = resolve;
      }) as never
    );
    const onAccepted = vi.fn();
    const onRejectedBeforeAcceptance = vi.fn();
    const submission = acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish: vi.fn(),
      onAccepted,
      onRejectedBeforeAcceptance,
    });
    const pending = {
      ...snapshotWithActivePrompt(
        vi.mocked(acpChatSessionActions.startPromptAttempt).mock.calls[0][1]
      ),
      activeRunId: null,
    };

    notifySnapshot?.({ ...pending, messages: [{ ...userMessage(), id: 'older-message' }] });
    notifySnapshot?.({ ...pending, messages: [{ ...userMessage(), role: 'assistant' }] });
    notifySnapshot?.({
      ...pending,
      activePromptAttemptId: 'older-attempt',
      messages: [userMessage()],
    });
    expect(onAccepted).not.toHaveBeenCalled();
    notifySnapshot?.({ ...pending, messages: [userMessage()] });
    expect(onAccepted).toHaveBeenCalledOnce();
    notifySnapshot?.({ ...pending, activeRunId: 'run-1', messages: [userMessage()] });
    finishPrompt?.({ stopReason: 'end_turn' });
    await submission;
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onRejectedBeforeAcceptance).not.toHaveBeenCalled();
  });

  it('does not use a pre-existing user message as a new submission receipt', async () => {
    const previous = { ...snapshotWithActivePrompt(null), messages: [userMessage()] };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(previous);
    let notifySnapshot: ((snapshot: AcpChatSessionSnapshot) => void) | undefined;
    vi.mocked(subscribeToAcpChatSession).mockImplementation((_sessionId, listener) => {
      notifySnapshot = listener;
      return () => undefined;
    });
    let finishPrompt: ((value: { stopReason: string }) => void) | undefined;
    vi.mocked(acpPromptSession).mockReturnValue(
      new Promise((resolve) => {
        finishPrompt = resolve;
      }) as never
    );
    const onAccepted = vi.fn();
    const onRejectedBeforeAcceptance = vi.fn();
    const submission = acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => previous,
      onFinish: vi.fn(),
      onAccepted,
      onRejectedBeforeAcceptance,
    });
    notifySnapshot?.({
      ...previous,
      activePromptAttemptId: vi.mocked(acpChatSessionActions.startPromptAttempt).mock.calls[0][1],
      activeRunId: null,
    });
    expect(onAccepted).not.toHaveBeenCalled();
    finishPrompt?.({ stopReason: 'cancelled' });
    await submission;
    expect(onRejectedBeforeAcceptance).toHaveBeenCalledOnce();
  });

  it('acknowledges server receipt from the active run before the agent turn completes', async () => {
    let notifySnapshot: ((snapshot: AcpChatSessionSnapshot) => void) | undefined;
    vi.mocked(subscribeToAcpChatSession).mockImplementation((_sessionId, listener) => {
      notifySnapshot = listener;
      return () => undefined;
    });
    let finishPrompt: ((value: { stopReason: string }) => void) | undefined;
    vi.mocked(acpPromptSession).mockReturnValue(
      new Promise((resolve) => {
        finishPrompt = resolve;
      }) as never
    );
    const onAccepted = vi.fn();
    const submission = acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish: vi.fn(),
      onAccepted,
    });

    await vi.waitFor(() => expect(notifySnapshot).toBeDefined());
    notifySnapshot?.({
      ...snapshotWithActivePrompt(
        vi.mocked(acpChatSessionActions.startPromptAttempt).mock.calls[0][1]
      ),
      activeRunId: 'run-1',
    });
    expect(onAccepted).toHaveBeenCalledOnce();

    finishPrompt?.({ stopReason: 'end_turn' });
    await submission;
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(acpChatSessionActions.finishPromptRequest).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String)
    );
  });

  it('clears a pending cancellation barrier when the original prompt settles', async () => {
    vi.mocked(acpChatSessionActions.clearPromptCancellation).mockReturnValueOnce(
      snapshotWithActivePrompt(null)
    );
    const onFinish = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish,
    });

    expect(acpChatSessionActions.clearPromptCancellation).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String)
    );
    expect(acpChatSessionActions.finishPromptAttemptIfCurrent).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('rejects while a cancellation barrier is pending', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      ...snapshotWithActivePrompt(null),
      pendingCancelPromptAttemptId: 'attempt-1',
    });

    await expect(
      acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
        getCurrentSnapshot: () => snapshotWithActivePrompt(null),
        onFinish: vi.fn(),
      })
    ).rejects.toThrow('Cannot submit while prompt cancellation is pending');

    expect(acpChatSessionActions.startPromptAttempt).not.toHaveBeenCalled();
    expect(acpPromptSession).not.toHaveBeenCalled();
  });

  it('maps an ACP cancelled stop reason to the structured cancellation terminal state', async () => {
    const cancelledSnapshot = {
      ...snapshotWithActivePrompt(null),
      pendingCancelPromptAttemptId: 'attempt-from-call',
    };
    vi.mocked(acpChatSessionActions.startPromptCancellation).mockReturnValue(cancelledSnapshot);
    const onFinish = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish,
    });

    const promptAttemptId = vi.mocked(acpChatSessionActions.startPromptAttempt).mock.calls[0][1];
    expect(acpChatSessionActions.startPromptCancellation).toHaveBeenCalledWith(
      SESSION_ID,
      promptAttemptId
    );
    expect(acpChatSessionActions.clearPromptCancellation).toHaveBeenCalledWith(
      SESSION_ID,
      promptAttemptId
    );
    expect(acpChatSessionActions.finishPromptAttemptIfCurrent).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('reports a prompt failure without marking the session load as failed', async () => {
    vi.mocked(acpPromptSession).mockRejectedValueOnce(new Error('workspace rejected'));
    const onFinish = vi.fn();
    const onDeliveryUncertain = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish,
      onDeliveryUncertain,
    });

    const promptAttemptId = vi.mocked(acpChatSessionActions.startPromptAttempt).mock.calls[0][1];
    expect(acpChatSessionActions.finishPromptAttemptIfCurrent).toHaveBeenCalledWith(
      SESSION_ID,
      promptAttemptId,
      'Submit error: workspace rejected'
    );
    expect(acpChatSessionActions.failSessionLoad).not.toHaveBeenCalled();
    expect(onDeliveryUncertain).toHaveBeenCalledOnce();
    expect(acpChatSessionActions.finishPromptRequest).toHaveBeenCalledWith(
      SESSION_ID,
      promptAttemptId
    );
    expect(onFinish).toHaveBeenCalledWith('Submit error: workspace rejected');
  });

  it('keeps an observed failure explanation when the prompt RPC later rejects', async () => {
    vi.mocked(acpPromptSession).mockRejectedValueOnce(new Error('raw provider failure'));
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      ...snapshotWithActivePrompt(null),
      promptError: '模型服务未通过身份验证（HTTP 401）',
    });
    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish: vi.fn(),
    });
    expect(acpChatSessionActions.finishPromptAttemptIfCurrent).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      '模型服务未通过身份验证（HTTP 401）'
    );
    expect(acpPromptSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the Chinese image error without exposing an English transport prefix', async () => {
    const message = '所选备用模型尚未确认支持图片，请选择支持图片的模型。';
    vi.mocked(acpPromptSession).mockRejectedValueOnce(
      Object.assign(new Error(message), {
        data: { kind: 'vision_error', reason: 'image_not_supported' },
      })
    );
    const onFinish = vi.fn();
    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt(null),
      onFinish,
    });
    expect(onFinish).toHaveBeenCalledWith(message);
    expect(acpChatSessionActions.failSessionLoad).not.toHaveBeenCalled();
  });

  it('preserves the active prompt while ACP reconnect replays the durable run', async () => {
    vi.mocked(isAcpRecovering).mockReturnValue(true);
    vi.mocked(acpPromptSession).mockRejectedValueOnce(new Error('ACP connection closed'));
    const onFinish = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => snapshotWithActivePrompt('attempt-1'),
      onFinish,
    });

    expect(acpPromptSession).toHaveBeenCalledTimes(1);
    expect(acpChatSessionActions.finishPromptAttemptIfCurrent).not.toHaveBeenCalled();
    expect(acpChatSessionActions.failSessionLoad).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    expect(acpChatSessionActions.finishPromptRequest).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String)
    );
  });

  it('resumes after workspace allocation without appending a second user message', async () => {
    const source = userMessage();
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [source],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);
    vi.mocked(acpPromptSession).mockResolvedValueOnce({ stopReason: 'end_turn' } as never);

    await acpChatSessionController.resumeAfterWorkspace(SESSION_ID, source, 'run-original', {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish: vi.fn(),
    });

    expect(acpChatSessionActions.setMessages).not.toHaveBeenCalled();
    expect(acpPromptSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        id: 'message-1',
        content: [],
        metadata: expect.objectContaining({ userVisible: false, agentVisible: false }),
      }),
      {
        schemaVersion: 1,
        strategy: 'resume_after_workspace',
        checkpointId: null,
        sourceRunId: 'run-original',
        sourceUserMessageId: 'message-1',
      }
    );
  });

  it('restores one original user message after workspace rebinding replays it', async () => {
    const source = userMessage();
    const replayedSource: Message = {
      ...source,
      content: [{ type: 'text', text: 'original requestoriginal request' }],
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [replayedSource, { ...source }],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);
    vi.mocked(acpPromptSession).mockResolvedValueOnce({ stopReason: 'end_turn' } as never);

    await acpChatSessionController.resumeAfterWorkspace(SESSION_ID, source, 'run-original', {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish: vi.fn(),
    });

    expect(acpChatSessionActions.setMessages).toHaveBeenCalledWith(SESSION_ID, [source]);
  });

  it('removes an identical workspace replay even when the server assigns a different id', async () => {
    const source = userMessage();
    const replayedSource: Message = {
      ...source,
      id: 'server-replay-message',
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [source, replayedSource],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);
    vi.mocked(acpPromptSession).mockResolvedValueOnce({ stopReason: 'end_turn' } as never);

    await acpChatSessionController.resumeAfterWorkspace(SESSION_ID, source, 'run-original', {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish: vi.fn(),
    });

    expect(acpChatSessionActions.setMessages).toHaveBeenCalledWith(SESSION_ID, [source]);
  });

  it('automatically continues a newly-created internal checkpoint', async () => {
    let currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [userMessage()],
    };
    vi.mocked(acpPromptSession)
      .mockImplementationOnce(async () => {
        currentSnapshot = {
          ...currentSnapshot,
          messages: [...currentSnapshot.messages, checkpointMessage(1)],
        };
        return { stopReason: 'end_turn' } as never;
      })
      .mockResolvedValueOnce({ stopReason: 'end_turn' } as never);
    const onFinish = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish,
    });

    expect(acpPromptSession).toHaveBeenCalledTimes(2);
    expect(acpPromptSession).toHaveBeenNthCalledWith(
      2,
      SESSION_ID,
      expect.objectContaining({
        role: 'user',
        metadata: expect.objectContaining({ userVisible: false }),
      }),
      {
        schemaVersion: 1,
        strategy: 'continue_checkpoint',
        checkpointId: 'checkpoint-1',
        sourceRunId: 'run-1',
        sourceUserMessageId: 'message-1',
      }
    );
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('waits for explicit user confirmation instead of automatically resuming a user-input checkpoint', async () => {
    let currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [userMessage()],
    };
    vi.mocked(acpPromptSession).mockImplementationOnce(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        messages: [...currentSnapshot.messages, checkpointMessage(1, 'ask_user')],
      };
      return { stopReason: 'end_turn' } as never;
    });
    const onFinish = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish,
    });

    expect(acpPromptSession).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('associates a user-input reply with the checkpoint for backend interpretation', async () => {
    const source = userMessage();
    const waiting = checkpointMessage(1, 'ask_user');
    const reply: Message = {
      ...userMessage(),
      id: 'user-confirmation',
      content: [{ type: 'text', text: '跳过该命令，只做静态分析。' }],
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [source, waiting, reply],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);
    vi.mocked(acpPromptSession).mockResolvedValueOnce({ stopReason: 'end_turn' } as never);

    await acpChatSessionController.submitMessage(SESSION_ID, reply, {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish: vi.fn(),
    });

    expect(acpPromptSession).toHaveBeenCalledWith(SESSION_ID, reply, undefined, {
      schemaVersion: 1,
      checkpointId: 'checkpoint-1',
      sourceRunId: 'run-1',
      sourceUserMessageId: 'message-1',
      sourceTerminalMessageId: waiting.id,
    });
  });

  it('bounds automatic checkpoint continuation to prevent an infinite retry loop', async () => {
    let currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [userMessage()],
    };
    vi.mocked(acpPromptSession).mockImplementation(async () => {
      const nextIndex = vi.mocked(acpPromptSession).mock.calls.length;
      currentSnapshot = {
        ...currentSnapshot,
        messages: [...currentSnapshot.messages, checkpointMessage(nextIndex)],
      };
      return { stopReason: 'end_turn' } as never;
    });
    const onFinish = vi.fn();

    await acpChatSessionController.submitMessage(SESSION_ID, userMessage(), {
      getCurrentSnapshot: () => currentSnapshot,
      onFinish,
    });

    expect(acpPromptSession).toHaveBeenCalledTimes(4);
    expect(onFinish).toHaveBeenCalledOnce();
  });
});

describe('acpChatSessionController.updateMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpTruncateSessionConversation).mockResolvedValue(undefined as never);
    vi.mocked(acpPromptSession).mockResolvedValue({ stopReason: 'end_turn' } as never);
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(snapshotWithActivePrompt(null));
    vi.mocked(acpChatSessionActions.waitForPromptCancellation).mockResolvedValue(undefined);
  });

  it('retries an ordinary response in the current session without forking', async () => {
    const source: Message & { id: string } = {
      ...userMessage(),
      content: [
        { type: 'text', text: 'Fix the project' },
        { type: 'image', data: 'source-image', mimeType: 'image/png' },
      ],
    };
    const response: Message & { id: string } = {
      id: 'assistant-response',
      role: 'assistant',
      created: 124,
      content: [{ type: 'text', text: 'The request failed' }],
      metadata: { userVisible: true, agentVisible: true },
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
      messages: [source, response],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);

    await acpChatSessionController.updateMessage(
      SESSION_ID,
      source.id,
      'Fix the project',
      'retry' as never,
      { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
    );

    expect(acpChatSessionActions.setMessages).toHaveBeenCalledWith(SESSION_ID, [
      source,
      response,
      expect.objectContaining({
        role: 'user',
        content: [
          { type: 'text', text: 'Fix the project' },
          { type: 'image', data: 'source-image', mimeType: 'image/png' },
        ],
      }),
    ]);
    const retriedMessage = vi.mocked(acpPromptSession).mock.calls[0]?.[1];
    expect(retriedMessage?.id).not.toBe(source.id);
    expect(acpPromptSession).toHaveBeenCalledWith(SESSION_ID, retriedMessage, undefined);
    expect(acpForkSession).not.toHaveBeenCalled();
    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
  });

  it('does not append a retry while another prompt is active', async () => {
    const source = userMessage();
    const activeSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt('attempt-1'),
      session: loadedSession(),
      messages: [source],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(activeSnapshot);

    await expect(
      acpChatSessionController.updateMessage(SESSION_ID, source.id, 'Hello', 'retry', {
        getCurrentSnapshot: () => activeSnapshot,
        onFinish: vi.fn(),
      })
    ).rejects.toThrow('Cannot retry while a prompt is active');

    expect(acpChatSessionActions.setMessages).not.toHaveBeenCalled();
    expect(acpPromptSession).not.toHaveBeenCalled();
    expect(acpForkSession).not.toHaveBeenCalled();
  });

  it('continues a paused CodePro run without truncating the existing conversation', async () => {
    const checkpointMessage: Message & { id: string } = {
      id: 'checkpoint-message',
      role: 'assistant',
      created: 124,
      content: [
        {
          type: 'text',
          text: '本轮操作测试 Agent 行动已上限，当前进度已经保存。',
        },
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'Paused with checkpoint',
          data: {
            schema_version: 1,
            session_id: SESSION_ID,
            run_id: 'run-1',
            terminal_message_id: 'checkpoint-message',
            source_user_message_id: 'message-1',
            status: 'interrupted',
            checkpoint_id: 'checkpoint-1',
            retry_strategy: 'continue_checkpoint',
            visible_text_available: true,
            tool_action_count: 2,
            copy_artifact_ref: null,
            finished_at: '2026-07-31T12:00:00.000Z',
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
      messages: [userMessage(), checkpointMessage],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);

    await acpChatSessionController.updateMessage(
      SESSION_ID,
      checkpointMessage.id,
      '继续执行',
      'continue',
      {
        getCurrentSnapshot: () => currentSnapshot,
        onFinish: vi.fn(),
      }
    );

    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setMessages).not.toHaveBeenCalled();
    expect(acpPromptSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ role: 'user' }),
      {
        schemaVersion: 1,
        strategy: 'continue_checkpoint',
        checkpointId: 'checkpoint-1',
        sourceRunId: 'run-1',
        sourceUserMessageId: 'message-1',
      }
    );
  });

  it('replays the source request as a linked run without changing old evidence', async () => {
    const source = userMessage();
    const terminalMessage: Message & { id: string } = {
      id: 'cancelled-terminal',
      role: 'assistant',
      created: 125,
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'Stopped without checkpoint',
          data: {
            schema_version: 1,
            session_id: SESSION_ID,
            run_id: 'run-1',
            terminal_message_id: 'cancelled-terminal',
            source_user_message_id: source.id,
            status: 'cancelled',
            checkpoint_id: null,
            retry_strategy: 'replay_user_request',
            visible_text_available: false,
            tool_action_count: 2,
            copy_artifact_ref: null,
            finished_at: '2026-07-31T12:00:00.000Z',
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: false },
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
      messages: [source, terminalMessage],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);

    await acpChatSessionController.updateMessage(
      SESSION_ID,
      terminalMessage.id,
      'Hello',
      'replay' as never,
      { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
    );

    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setMessages).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([source, terminalMessage, expect.objectContaining({ role: 'user' })])
    );
    expect(acpPromptSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ role: 'user' }),
      {
        schemaVersion: 1,
        strategy: 'replay_user_request',
        checkpointId: null,
        sourceRunId: 'run-1',
        sourceUserMessageId: source.id,
      }
    );
  });

  it.each([false, undefined] as const)(
    'replays the exact persisted source request when legacy visibility metadata is %s',
    async (userVisible) => {
      const source = userMessage();
      source.metadata = {
        agentVisible: true,
        ...(userVisible === undefined ? {} : { userVisible }),
      } as Message['metadata'];
      const terminalMessage: Message & { id: string } = {
        id: 'persisted-replay-terminal',
        role: 'assistant',
        created: 126,
        content: [
          {
            type: 'systemNotification',
            notificationType: 'turnTerminal',
            msg: 'Stopped without checkpoint',
            data: {
              schema_version: 1,
              session_id: SESSION_ID,
              run_id: 'run-persisted',
              terminal_message_id: 'persisted-replay-terminal',
              source_user_message_id: source.id,
              status: 'interrupted',
              checkpoint_id: null,
              retry_strategy: 'replay_user_request',
              visible_text_available: true,
              tool_action_count: 0,
              copy_artifact_ref: null,
              finished_at: '2026-08-28T04:26:21.356Z',
            },
          },
        ],
        metadata: { userVisible: true, agentVisible: false },
      };
      const currentSnapshot: AcpChatSessionSnapshot = {
        ...snapshotWithActivePrompt(null),
        session: loadedSession(),
        messages: [source, terminalMessage],
      };
      const persistedSource: Message & { id: string } = {
        ...source,
        metadata: { userVisible: true, agentVisible: true },
      };
      const restoredSnapshot: AcpChatSessionSnapshot = {
        ...currentSnapshot,
        messages: [persistedSource, terminalMessage],
      };
      let storedSnapshot = currentSnapshot;
      vi.mocked(acpChatSessionStore.getSnapshot).mockImplementation(() => storedSnapshot);
      vi.mocked(acpLoadSession).mockImplementation(async () => {
        storedSnapshot = restoredSnapshot;
        return mockLoadResult();
      });
      vi.mocked(sessionInfoToSession).mockReturnValue(loadedSession());

      await acpChatSessionController.updateMessage(
        SESSION_ID,
        terminalMessage.id,
        'Retry',
        'replay' as never,
        { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
      );

      expect(acpPromptSession).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        }),
        expect.objectContaining({
          strategy: 'replay_user_request',
          sourceUserMessageId: source.id,
        })
      );
      expect(acpLoadSession).toHaveBeenCalledWith(SESSION_ID);
    }
  );

  it('rejects replay when the terminal source id does not bind to an exact user message', async () => {
    const source = userMessage();
    const terminalMessage: Message & { id: string } = {
      id: 'unbound-replay-terminal',
      role: 'assistant',
      created: 127,
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'Stopped without checkpoint',
          data: {
            schema_version: 1,
            session_id: SESSION_ID,
            run_id: 'run-unbound',
            terminal_message_id: 'unbound-replay-terminal',
            source_user_message_id: 'different-user-message',
            status: 'interrupted',
            checkpoint_id: null,
            retry_strategy: 'replay_user_request',
            visible_text_available: true,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: '2026-08-28T04:26:21.356Z',
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: false },
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
      messages: [source, terminalMessage],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);

    await expect(
      acpChatSessionController.updateMessage(
        SESSION_ID,
        terminalMessage.id,
        'Retry',
        'replay' as never,
        { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
      )
    ).rejects.toThrow('Only a terminal with an original user request can create a linked replay');

    expect(acpPromptSession).not.toHaveBeenCalled();
  });

  it('restores the persisted conversation when the live snapshot omitted the exact source', async () => {
    const source = userMessage();
    const terminalMessage: Message & { id: string } = {
      id: 'persisted-source-terminal',
      role: 'assistant',
      created: 128,
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'Stopped without checkpoint',
          data: {
            schema_version: 1,
            session_id: SESSION_ID,
            run_id: 'run-persisted-source',
            terminal_message_id: 'persisted-source-terminal',
            source_user_message_id: source.id,
            status: 'interrupted',
            checkpoint_id: null,
            retry_strategy: 'replay_user_request',
            visible_text_available: true,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: '2026-08-28T04:26:21.356Z',
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: false },
    };
    const liveSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
      messages: [terminalMessage],
    };
    const restoredSnapshot: AcpChatSessionSnapshot = {
      ...liveSnapshot,
      messages: [source, terminalMessage],
    };
    let storedSnapshot = liveSnapshot;
    vi.mocked(acpChatSessionStore.getSnapshot).mockImplementation(() => storedSnapshot);
    vi.mocked(acpLoadSession).mockImplementation(async () => {
      storedSnapshot = restoredSnapshot;
      return mockLoadResult();
    });
    vi.mocked(sessionInfoToSession).mockReturnValue(loadedSession());

    await acpChatSessionController.updateMessage(
      SESSION_ID,
      terminalMessage.id,
      'Retry',
      'replay' as never,
      { getCurrentSnapshot: () => liveSnapshot, onFinish: vi.fn() }
    );

    expect(acpLoadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(acpPromptSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ content: [{ type: 'text', text: 'Hello' }] }),
      expect.objectContaining({
        strategy: 'replay_user_request',
        sourceUserMessageId: source.id,
      })
    );
  });

  it('retries failed validation by appending a linked user message without truncation', async () => {
    const source = userMessage();
    const terminalMessage: Message & { id: string } = {
      id: 'failed-validation-terminal',
      role: 'assistant',
      created: 126,
      content: [
        { type: 'text', text: '单文件修改终态：FAIL' },
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'CodePro simple change terminal',
          data: {
            schema_version: 1,
            session_id: SESSION_ID,
            run_id: 'run-validation-1',
            terminal_message_id: 'failed-validation-terminal',
            source_user_message_id: source.id,
            status: 'failed',
            checkpoint_id: null,
            retry_strategy: 'retry_failed_validation',
            visible_text_available: true,
            tool_action_count: 2,
            copy_artifact_ref: null,
            finished_at: '2026-08-01T12:00:00Z',
            retry_of_terminal_message_id: null,
            validation_retry: {
              target_path: 'D:\\project\\app.rs',
              command: 'cargo check',
              exit_code: 1,
            },
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      session: loadedSession(),
      messages: [source, terminalMessage],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);

    await acpChatSessionController.updateMessage(
      SESSION_ID,
      terminalMessage.id,
      '不得复制 cargo check 到用户消息',
      'retry_validation' as never,
      { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
    );

    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setMessages).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([source, terminalMessage, expect.objectContaining({ role: 'user' })])
    );
    expect(acpPromptSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: '重新运行失败验证' }],
      }),
      {
        schemaVersion: 1,
        strategy: 'retry_failed_validation',
        checkpointId: null,
        sourceRunId: 'run-validation-1',
        sourceUserMessageId: source.id,
        sourceTerminalMessageId: terminalMessage.id,
      }
    );
  });

  it('rejects an unavailable retry mode instead of treating it as an in-place edit', async () => {
    const existingMessage = userMessage();
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [existingMessage],
    };
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(currentSnapshot);

    await expect(
      acpChatSessionController.updateMessage(
        SESSION_ID,
        existingMessage.id,
        'must not be dispatched',
        'none' as never,
        { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
      )
    ).rejects.toThrow('Unsupported message edit type: none');

    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setMessages).not.toHaveBeenCalled();
    expect(acpPromptSession).not.toHaveBeenCalled();
  });

  it('rejects edits before truncating while cancellation is pending', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      ...snapshotWithActivePrompt(null),
      pendingCancelPromptAttemptId: 'attempt-1',
    });
    const existingMessage = userMessage();
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [existingMessage],
    };

    await expect(
      acpChatSessionController.updateMessage(SESSION_ID, existingMessage.id, 'Updated', 'edit', {
        getCurrentSnapshot: () => currentSnapshot,
        onFinish: vi.fn(),
      })
    ).rejects.toThrow('Cannot submit while prompt cancellation is pending');

    expect(acpChatSessionActions.setChatState).not.toHaveBeenCalledWith(
      SESSION_ID,
      ChatState.Thinking
    );
    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setMessages).not.toHaveBeenCalled();
    expect(acpPromptSession).not.toHaveBeenCalled();
  });

  it('ignores edits before truncating while a prompt is active', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(
      snapshotWithActivePrompt('attempt-1')
    );
    const existingMessage = userMessage();
    const currentSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt('attempt-1'),
      messages: [existingMessage],
    };

    await expect(
      acpChatSessionController.updateMessage(SESSION_ID, existingMessage.id, 'Updated', 'edit', {
        getCurrentSnapshot: () => currentSnapshot,
        onFinish: vi.fn(),
      })
    ).resolves.toBeUndefined();

    expect(acpChatSessionActions.setChatState).not.toHaveBeenCalledWith(
      SESSION_ID,
      ChatState.Thinking
    );
    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpChatSessionActions.setMessages).not.toHaveBeenCalled();
    expect(acpPromptSession).not.toHaveBeenCalled();
  });

  it('waits for pending tool permission cancellation before truncating and rerunning', async () => {
    const existingMessage = userMessage();
    const permissionMessage = pendingToolPermissionMessage();
    const activeSnapshot: AcpChatSessionSnapshot = {
      ...snapshotWithActivePrompt('attempt-1'),
      chatState: ChatState.WaitingForUserInput,
      messages: [existingMessage, permissionMessage],
    };
    let storedSnapshot = activeSnapshot;
    vi.mocked(acpChatSessionStore.getSnapshot).mockImplementation(() => storedSnapshot);
    vi.mocked(acpChatSessionActions.startPromptCancellation).mockReturnValue({
      ...activeSnapshot,
      activePromptAttemptId: null,
      pendingCancelPromptAttemptId: 'attempt-1',
    });
    vi.mocked(acpCancelPrompt).mockResolvedValue(undefined);

    let resolvePromptCancellation: () => void;
    const promptCancellationSettled = new Promise<void>((resolve) => {
      resolvePromptCancellation = resolve;
    });
    vi.mocked(acpChatSessionActions.waitForPromptCancellation).mockReturnValue(
      promptCancellationSettled
    );

    const updatePromise = acpChatSessionController.updateMessage(
      SESSION_ID,
      existingMessage.id,
      'Updated',
      'edit',
      {
        getCurrentSnapshot: () => activeSnapshot,
        onFinish: vi.fn(),
      }
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(acpCancelPrompt).toHaveBeenCalledWith(SESSION_ID);
    expect(acpChatSessionActions.waitForPromptCancellation).toHaveBeenCalledWith(
      SESSION_ID,
      'attempt-1'
    );
    expect(acpTruncateSessionConversation).not.toHaveBeenCalled();
    expect(acpPromptSession).not.toHaveBeenCalled();

    storedSnapshot = {
      ...snapshotWithActivePrompt(null),
      messages: [existingMessage, permissionMessage],
    };
    resolvePromptCancellation!();
    await updatePromise;

    expect(acpTruncateSessionConversation).toHaveBeenCalledWith(
      SESSION_ID,
      existingMessage.created
    );
    expect(acpPromptSession).toHaveBeenCalled();
    expect(acpChatSessionActions.clearPromptCancellation).not.toHaveBeenCalledWith(
      SESSION_ID,
      'attempt-1'
    );
  });
});
