import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { acpChatSessionActions as actions } from '../acp/chatSessionStore';
import type { Session } from '../types/session';
import type { PetTask } from './petTypes';
import { requestAcpPermission, resolvePetPermission } from '../acp/permissionRequests';
import { requestAcpElicitation, getPendingAcpElicitationRequests, cancelAcpElicitationRequest, applyNativeQuestionSnapshot } from '../acp/elicitationRequests';

const signal = vi.fn();
let sessionId: string;
const lastTask = () => {
  const tasks = signal.mock.calls.filter(([channel]) => channel === 'pet-task');
  return tasks[tasks.length - 1]?.[1] as PetTask;
};
function terminal(id: string): GooseSessionNotification_unstable {
  return {
    sessionId,
    update: {
      sessionUpdate: 'status_message',
      status: {
        type: 'progress',
        message: 'structured fixture',
        data: {
          schema_version: 1,
          session_id: sessionId,
          run_id: 'run-1',
          terminal_message_id: id,
          source_user_message_id: 'user-1',
          status: 'completed',
          checkpoint_id: null,
          retry_strategy: 'not_available',
          visible_text_available: true,
          tool_action_count: 0,
          copy_artifact_ref: null,
          finished_at: '2026-10-19T10:00:00Z',
        },
      },
    },
  } as GooseSessionNotification_unstable;
}

describe('ACP pet notification lifecycle', () => {
  beforeEach(() => {
    sessionId = `pet-lifecycle-${randomUUID()}`;
    signal.mockClear();
    Object.assign(window.electron, { desktopPet: vi.fn(), petSignal: signal });
  });
  afterEach(() => actions.deleteSnapshot(sessionId));

  it('tracks answerable questions independently of whether execution is blocked', async () => {
    const request = { sessionId, message: '', mode: 'form' as const,
      requestedSchema: { type: 'object' as const, required: ['answer_0'],
        properties: { answer_0: { type: 'string' as const, title: 'Choose a folder' } } },
      _meta: { 'codebuddy/question': { nativeSessionId: sessionId, callId: 'q' } } };
    actions.startPromptAttempt(sessionId, 'attempt', 'user');
    const result = requestAcpElicitation(request);
    const [pending] = getPendingAcpElicitationRequests(sessionId);
    expect(lastTask()).toMatchObject({ state: 'input', questions: [{ id: pending.id, summary: 'Choose a folder' }] });
    applyNativeQuestionSnapshot(sessionId, { active: [{ state: 'continued', callId: 'q', request }], settled: [] });
    await expect(result).resolves.toMatchObject({ action: 'cancel' });
    expect(lastTask().state).not.toBe('input');
    expect(lastTask().questions?.[0].id).toBe(pending.id);
    expect(cancelAcpElicitationRequest(sessionId, pending.id)).toBe(true);
    expect(lastTask().questions).toBeUndefined();
  });

  it('publishes actionable live approvals and removes them after the pet resolves the same RPC', async () => {
    actions.startPromptAttempt(sessionId, 'attempt', 'user');
    const response = requestAcpPermission({ sessionId, toolCall: { toolCallId: 'call', title: 'Read notes', rawInput: { path: 'notes.md' } }, options: [{ optionId: 'yes', kind: 'allow_once', name: '允许一次' }, { optionId: 'no', kind: 'reject_once', name: '拒绝' }] });
    const pending = lastTask().inputRequest?.permission;
    expect(pending?.choices.map(choice => choice.action)).toEqual(['allow_once', 'deny_once']);
    expect(pending?.details).toContain('notes.md');
    expect(resolvePetPermission(sessionId, pending!.requestId, pending!.token, 'allow_once')).toBe(true);
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(lastTask().inputRequest?.permission).toBeUndefined();
  });

  it('shows live work and its structured completion without replaying historical completions', () => {
    actions.startSessionLoad(sessionId);
    actions.applyAcpGooseSessionNotification(terminal('old-terminal'));
    actions.finishSessionLoad(sessionId, { id: sessionId, name: 'Pet check' } as Session);
    expect(lastTask().state).toBe('idle');
    actions.startPromptAttempt(sessionId, 'attempt-1', 'user-1');
    actions.applyAcpSessionNotification({
      sessionId,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: 'run-1' } } },
    } as SessionNotification);
    expect(lastTask().state).toBe('working');
    actions.applyAcpGooseSessionNotification(terminal('live-terminal'));
    expect(lastTask()).toMatchObject({
      sessionId,
      state: 'completed',
      terminalId: 'live-terminal',
    });
  });

  it('removes reminders when the corresponding session snapshot is removed', () => {
    actions.startPromptAttempt(sessionId, 'attempt-1', 'user-1');
    actions.applyAcpSessionNotification({
      sessionId,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: 'run-1' } } },
    } as SessionNotification);
    actions.applyAcpGooseSessionNotification(terminal('live-terminal'));
    expect(lastTask().state).toBe('completed');
    actions.deleteSnapshot(sessionId);
    expect(lastTask()).toMatchObject({ sessionId, state: 'idle' });
    expect(lastTask().terminalId).toBeUndefined();
    actions.startSessionLoad(sessionId);
    actions.applyAcpGooseSessionNotification(terminal('live-terminal'));
    actions.finishSessionLoad(sessionId, { id: sessionId, name: 'Pet check' } as Session);
    expect(lastTask().state).toBe('idle');
  });
});
