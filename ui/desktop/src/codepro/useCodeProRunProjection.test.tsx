import { act, renderHook } from '@testing-library/react';
import type { CodeProRunSnapshot } from '@aaif/goose-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acpChatSessionController } from '../acp/chatSessionController';
import { acpChatSessionActions } from '../acp/chatSessionStore';
import { isAcpSessionLoadInFlight } from '../acp/sessions';
import type { Message } from '../types/message';
import { codeProRunCommands } from './runCommands';
import { applyCodeProRunSnapshot, clearAllCodeProRunProjections } from './runProjection';
import { useCodeProRunProjection } from './useCodeProRunProjection';

vi.mock('./runCommands', () => ({
  codeProRunCommands: { refresh: vi.fn() },
}));

vi.mock('../acp/chatSessionController', () => ({
  acpChatSessionController: { restoreSession: vi.fn() },
}));

vi.mock('../acp/sessions', () => ({
  isAcpSessionLoadInFlight: vi.fn(() => false),
}));

function snapshot(
  state: CodeProRunSnapshot['state'],
  lastSequence: number,
  sessionId = 'session-1',
  runId = 'run-1'
): CodeProRunSnapshot {
  const terminalEvent =
    state === 'completed'
      ? 'run_completed'
      : state === 'failed'
        ? 'run_failed'
        : state === 'cancelled'
          ? 'run_cancelled'
          : undefined;
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    state,
    goal: 'Analyze the project',
    planRevision: 1,
    lastSequence,
    recentEvents: terminalEvent
      ? [
          {
            eventId: `event:${lastSequence}`,
            sequence: lastSequence,
            eventType: terminalEvent,
            occurredAt: '2026-09-14T00:00:00Z',
            evidence: [],
          },
        ]
      : [],
    coordinator: {
      requestedMode: 'authoritative',
      effectiveMode: 'authoritative',
      qualification: 'qualified',
      reason: 'test',
    },
  };
}

function terminalMessage(
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
  sourceUserMessageId: string,
  terminalMessageId = `terminal-${sourceUserMessageId}`,
  runId = 'run-1'
): Message {
  return {
    id: terminalMessageId,
    role: 'assistant',
    created: 1,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: 'CodePro turn finished',
        data: {
          schema_version: 1,
          session_id: 'session-1',
          run_id: runId,
          terminal_message_id: terminalMessageId,
          source_user_message_id: sourceUserMessageId,
          status,
          checkpoint_id: null,
          retry_strategy: 'not_available',
          visible_text_available: true,
          tool_action_count: 0,
          copy_artifact_ref: null,
          finished_at: '2026-09-14T00:00:01Z',
        },
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  };
}

describe('useCodeProRunProjection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);
    clearAllCodeProRunProjections();
    acpChatSessionActions.deleteSnapshot('session-1');
    acpChatSessionActions.deleteSnapshot('session-2');
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllCodeProRunProjections();
    acpChatSessionActions.deleteSnapshot('session-1');
    acpChatSessionActions.deleteSnapshot('session-2');
  });

  it('polls a live durable run and replays its terminal session exactly once', async () => {
    vi.mocked(codeProRunCommands.refresh)
      .mockImplementationOnce(async () => applyCodeProRunSnapshot(snapshot('running', 1)))
      .mockImplementationOnce(async () => applyCodeProRunSnapshot(snapshot('completed', 2)));
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(codeProRunCommands.refresh).toHaveBeenCalledTimes(1);
    expect(hook.result.current.projection?.state).toBe('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);
    expect(hook.result.current.projection?.state).toBe('completed');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(codeProRunCommands.refresh).toHaveBeenCalledTimes(2);
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('does not accumulate overlapping polls while one refresh is still pending', async () => {
    let resolveRefresh: ((value: CodeProRunSnapshot) => void) | undefined;
    vi.mocked(codeProRunCommands.refresh).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = (value) => resolve(applyCodeProRunSnapshot(value));
        })
    );

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(codeProRunCommands.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh?.(snapshot('completed', 14));
      await Promise.resolve();
    });
    expect(hook.result.current.projection?.state).toBe('completed');
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('waits for the active prompt to settle and skips reload when its terminal arrives live', async () => {
    acpChatSessionActions.startPromptAttempt('session-1', 'attempt-1', 'source-current');
    vi.mocked(codeProRunCommands.refresh).mockImplementation(async () =>
      applyCodeProRunSnapshot(snapshot('completed', 20))
    );
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(acpChatSessionController.restoreSession).not.toHaveBeenCalled();

    act(() => {
      acpChatSessionActions.setMessages('session-1', [
        terminalMessage('completed', 'source-current'),
      ]);
      acpChatSessionActions.finishPromptAttemptIfCurrent('session-1', 'attempt-1');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('reloads after the prompt settles when only an older same-run terminal exists', async () => {
    acpChatSessionActions.setMessages('session-1', [
      terminalMessage('cancelled', 'source-previous'),
    ]);
    acpChatSessionActions.startPromptAttempt('session-1', 'attempt-2', 'source-current');
    vi.mocked(codeProRunCommands.refresh).mockImplementation(async () =>
      applyCodeProRunSnapshot(snapshot('cancelled', 30))
    );
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(acpChatSessionController.restoreSession).not.toHaveBeenCalled();

    act(() => {
      acpChatSessionActions.finishPromptAttemptIfCurrent('session-1', 'attempt-2');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledWith('session-1');
    hook.unmount();
  });

  it('cancels a pending terminal reload when the hook switches sessions', async () => {
    acpChatSessionActions.startPromptAttempt('session-1', 'attempt-1', 'source-current');
    vi.mocked(codeProRunCommands.refresh).mockImplementation(async (sessionId, runId) =>
      applyCodeProRunSnapshot(snapshot('completed', 40, sessionId, runId))
    );
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(({ sessionId, runId }) => useCodeProRunProjection(sessionId, runId), {
      initialProps: { sessionId: 'session-1', runId: 'run-1' },
    });
    await act(async () => {
      await Promise.resolve();
    });
    hook.rerender({ sessionId: 'session-2', runId: 'run-2' });

    act(() => {
      acpChatSessionActions.finishPromptAttemptIfCurrent('session-1', 'attempt-1');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).not.toHaveBeenCalledWith('session-1');
    hook.unmount();
  });

  it('does not apply an old terminal projection or pending refresh to a new session', async () => {
    applyCodeProRunSnapshot(snapshot('completed', 45, 'session-1', 'run-1'));
    vi.mocked(isAcpSessionLoadInFlight).mockImplementation(
      (sessionId) => sessionId === 'session-1'
    );
    vi.mocked(codeProRunCommands.refresh).mockImplementation((sessionId, runId) =>
      sessionId === 'session-1'
        ? new Promise(() => {})
        : Promise.resolve(applyCodeProRunSnapshot(snapshot('running', 46, sessionId, runId)))
    );
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(({ sessionId, runId }) => useCodeProRunProjection(sessionId, runId), {
      initialProps: { sessionId: 'session-1', runId: 'run-1' },
    });
    await act(async () => {
      await Promise.resolve();
    });

    hook.rerender({ sessionId: 'session-2', runId: 'run-2' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).not.toHaveBeenCalledWith('session-2');
    expect(codeProRunCommands.refresh).toHaveBeenCalledWith('session-2', 'run-2');
    expect(hook.result.current.projection?.sessionId).toBe('session-2');
    expect(hook.result.current.projection?.state).toBe('running');
    hook.unmount();
  });

  it('waits for an existing session load instead of starting a second reload', async () => {
    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(true);
    vi.mocked(codeProRunCommands.refresh).mockImplementation(async () =>
      applyCodeProRunSnapshot(snapshot('failed', 50))
    );
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(acpChatSessionController.restoreSession).not.toHaveBeenCalled();

    vi.mocked(isAcpSessionLoadInFlight).mockReturnValue(false);
    act(() => {
      acpChatSessionActions.setMessages('session-1', []);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('does not reload again when later snapshots repeat the same terminal occurrence', async () => {
    const completed = snapshot('completed', 60);
    vi.mocked(codeProRunCommands.refresh).mockImplementation(async () =>
      applyCodeProRunSnapshot(completed)
    );
    vi.mocked(acpChatSessionController.restoreSession).mockImplementation(async () => {
      acpChatSessionActions.setMessages('session-1', [
        terminalMessage('completed', 'source-current'),
      ]);
    });

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);

    act(() => {
      applyCodeProRunSnapshot({
        ...snapshot('completed', 61),
        recentEvents: completed.recentEvents,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('allows an explicit refresh to retry a terminal reload that produced no terminal', async () => {
    vi.mocked(codeProRunCommands.refresh).mockImplementation(async () =>
      applyCodeProRunSnapshot(snapshot('failed', 70))
    );
    vi.mocked(acpChatSessionController.restoreSession).mockResolvedValue(undefined);

    const hook = renderHook(() => useCodeProRunProjection('session-1', 'run-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
