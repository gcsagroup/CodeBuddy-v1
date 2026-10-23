import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_ELICITATION_TIMEOUT_SECONDS,
  cancelAcpElicitationRequest,
  cancelAcpElicitationRequestsForSession,
  requestAcpElicitation,
  resolveAcpElicitationRequest,
  applyNativeQuestionSnapshot,
  getPendingAcpElicitationRequests,
  submitAcpElicitationResponse,
} from '../elicitationRequests';
import { acpChatSessionActions } from '../chatSessionStore';
const { extMethod } = vi.hoisted(() => ({ extMethod: vi.fn() }));
vi.mock('../acpConnection', () => ({ getAcpClient: async () => ({ extMethod }) }));

vi.mock('../chatSessionStore', () => ({
  acpElicitationUserInputRequestId: (elicitationId: string) => `elicitation:${elicitationId}`,
  acpChatSessionActions: {
    applyElicitationRequest: vi.fn(),
    resolveUserInputRequest: vi.fn(),
    setElicitationStatus: vi.fn(),
  },
}));

const TEST_SESSION_IDS = ['session-1', 'session-2'];

function formRequest(sessionId: string): CreateElicitationRequest {
  return {
    mode: 'form',
    sessionId,
    message: 'Choose a project',
    requestedSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
        },
      },
      required: ['project'],
    },
  };
}

async function expectStillPending(promise: Promise<CreateElicitationResponse>): Promise<void> {
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

describe('ACP elicitation requests', () => {
  it('keeps a native blocking plan review pending without inventing a deadline or approval', async () => {
    vi.useFakeTimers();
    const connection = new AbortController();
    try {
      const response = requestAcpElicitation(
        {
          ...formRequest('session-1'),
          _meta: { 'codebuddy/question-blocking': true },
        },
        connection.signal
      );
      expect(getPendingAcpElicitationRequests('session-1')[0].expiresAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(86_400_000);
      await expectStillPending(response);
      expect(acpChatSessionActions.setElicitationStatus).not.toHaveBeenCalled();
      connection.abort();
      await expect(response).resolves.toEqual({ action: 'cancel' });
    } finally {
      connection.abort();
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    for (const sessionId of TEST_SESSION_IDS) {
      cancelAcpElicitationRequestsForSession(sessionId);
    }
  });

  afterEach(() => {
    for (const sessionId of TEST_SESSION_IDS) {
      cancelAcpElicitationRequestsForSession(sessionId);
    }
  });

  it('keeps form requests pending until explicit resolve', async () => {
    const response = requestAcpElicitation(formRequest('session-1'));

    await expectStillPending(response);

    const appliedRequest = vi.mocked(acpChatSessionActions.applyElicitationRequest).mock
      .calls[0][0];

    expect(appliedRequest.id).toMatch(/^acp_elicitation_/);
    expect(appliedRequest.sessionId).toBe('session-1');
    expect(appliedRequest.request.message).toBe('Choose a project');

    expect(
      resolveAcpElicitationRequest('session-1', appliedRequest.id, {
        project: 'goose',
      })
    ).toBe(true);
    expect(acpChatSessionActions.setElicitationStatus).toHaveBeenCalledWith(
      'session-1',
      appliedRequest.id,
      'submitted'
    );
    expect(acpChatSessionActions.resolveUserInputRequest).toHaveBeenCalledWith(
      'session-1',
      `elicitation:${appliedRequest.id}`
    );

    await expect(response).resolves.toEqual({
      action: 'accept',
      content: {
        project: 'goose',
      },
    });
  });

  it('cancels unsupported requests', async () => {
    await expect(
      requestAcpElicitation({
        mode: 'url',
        requestId: 'request-1',
        elicitationId: 'elicitation-1',
        message: 'Open this page',
        url: 'https://example.com',
      })
    ).resolves.toEqual({ action: 'cancel' });
  });

  it('cancels only pending requests for the requested session', async () => {
    const sessionOneResponse = requestAcpElicitation(formRequest('session-1'));
    const sessionTwoResponse = requestAcpElicitation(formRequest('session-2'));

    const applyElicitationRequest = vi.mocked(acpChatSessionActions.applyElicitationRequest);
    const sessionOneRequest = applyElicitationRequest.mock.calls[0][0];
    const sessionTwoRequest = applyElicitationRequest.mock.calls[1][0];

    cancelAcpElicitationRequestsForSession('session-1');

    expect(acpChatSessionActions.setElicitationStatus).toHaveBeenCalledWith(
      'session-1',
      sessionOneRequest.id,
      'cancelled'
    );
    await expect(sessionOneResponse).resolves.toEqual({ action: 'cancel' });
    await expectStillPending(sessionTwoResponse);

    expect(resolveAcpElicitationRequest('session-2', sessionTwoRequest.id, {})).toBe(true);
    await expect(sessionTwoResponse).resolves.toEqual({
      action: 'accept',
      content: {},
    });
    expect(resolveAcpElicitationRequest('session-1', sessionOneRequest.id, {})).toBe(false);
  });

  it('cancels one request and unblocks its user-input slot', async () => {
    const response = requestAcpElicitation(formRequest('session-1'));
    const request = vi.mocked(acpChatSessionActions.applyElicitationRequest).mock.calls[0][0];

    expect(cancelAcpElicitationRequest('session-1', request.id)).toBe(true);
    expect(acpChatSessionActions.setElicitationStatus).toHaveBeenCalledWith(
      'session-1',
      request.id,
      'cancelled'
    );
    expect(acpChatSessionActions.resolveUserInputRequest).toHaveBeenCalledWith(
      'session-1',
      `elicitation:${request.id}`
    );
    await expect(response).resolves.toEqual({ action: 'cancel' });
    expect(cancelAcpElicitationRequest('session-1', request.id)).toBe(false);
  });

  it('cancels pending requests when they expire', async () => {
    vi.useFakeTimers();
    try {
      const response = requestAcpElicitation(formRequest('session-1'));
      const appliedRequest = vi.mocked(acpChatSessionActions.applyElicitationRequest).mock
        .calls[0][0];

      await expectStillPending(response);

      await vi.advanceTimersByTimeAsync(ACP_ELICITATION_TIMEOUT_SECONDS * 1000);

      expect(acpChatSessionActions.setElicitationStatus).toHaveBeenCalledWith(
        'session-1',
        appliedRequest.id,
        'expired'
      );
      expect(acpChatSessionActions.resolveUserInputRequest).toHaveBeenCalledWith(
        'session-1',
        `elicitation:${appliedRequest.id}`
      );
      await expect(response).resolves.toEqual({
        action: 'cancel',
        _meta: { codepro: { reason: 'expired' } },
      });
      expect(resolveAcpElicitationRequest('session-1', appliedRequest.id, {})).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the native timeout only for display and accepts a later answer while the turn remains open', async () => {
    vi.useFakeTimers();
    try {
      const request = {
        ...formRequest('session-1'),
        _meta: {
          'codebuddy/question': {
            callId: 'call-1',
            nativeSessionId: 'native-1',
            state: 'open',
            remainingMs: 1000,
          },
        },
      };
      const response = requestAcpElicitation(request);
      const initial = getPendingAcpElicitationRequests('session-1')[0];
      await vi.advanceTimersByTimeAsync(600_000);
      await expectStillPending(response);
      expect(acpChatSessionActions.setElicitationStatus).not.toHaveBeenCalledWith(
        'session-1',
        initial.id,
        'expired'
      );
      applyNativeQuestionSnapshot('session-1', {
        active: [{ callId: 'call-1', state: 'continued', request }],
        settled: [],
      });
      await expect(response).resolves.toEqual({ action: 'cancel' });
      expect(getPendingAcpElicitationRequests('session-1')[0]).toMatchObject({
        continued: true,
        id: initial.id,
      });
      expect(getPendingAcpElicitationRequests('session-1')[0].expiresAt).toBeUndefined();
      extMethod.mockResolvedValueOnce({ accepted: true });
      expect(
        await submitAcpElicitationResponse('session-1', initial.id, { project: 'goose' }, 'accept')
      ).toBe(true);
      expect(extMethod).toHaveBeenCalledWith('_goose/unstable/session/questions/answer', {
        sessionId: 'session-1',
        nativeSessionId: 'native-1',
        callId: 'call-1',
        response: { action: 'accept', content: { project: 'goose' } },
      });
      expect(getPendingAcpElicitationRequests('session-1')).toEqual([]);
      applyNativeQuestionSnapshot('session-1', {
        active: [{ callId: 'call-1', state: 'continued', request }],
        settled: [],
      });
      expect(getPendingAcpElicitationRequests('session-1')).toEqual([]);
      expect(
        await submitAcpElicitationResponse('session-1', initial.id, { project: 'again' }, 'accept')
      ).toBe(false);
      expect(extMethod).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes old late-answer cards on native turn end and disconnect without submitting an answer', async () => {
    const request = {
      ...formRequest('session-1'),
      _meta: {
        'codebuddy/question': {
          callId: 'call-1',
          nativeSessionId: 'native-1',
          state: 'continued',
        },
      },
    };
    const snapshot = { active: [{ callId: 'call-1', state: 'continued', request }], settled: [] };
    applyNativeQuestionSnapshot('session-2', snapshot);
    expect(getPendingAcpElicitationRequests('session-2')).toEqual([]);
    applyNativeQuestionSnapshot('session-1', snapshot);
    const id = getPendingAcpElicitationRequests('session-1')[0].id;
    applyNativeQuestionSnapshot('session-1', { active: [], settled: [] });
    expect(await submitAcpElicitationResponse('session-1', id, {}, 'accept')).toBe(false);
    const connection = new AbortController();
    applyNativeQuestionSnapshot('session-1', snapshot, connection.signal);
    connection.abort();
    expect(getPendingAcpElicitationRequests('session-1')).toEqual([]);
    expect(extMethod).not.toHaveBeenCalled();
  });

  it('a critical native question has no local deadline and is cancelled by connection loss', async () => {
    vi.useFakeTimers();
    try {
      const connection = new AbortController();
      const response = requestAcpElicitation(
        {
          ...formRequest('session-1'),
          _meta: {
            'codebuddy/question': {
              callId: 'required',
              nativeSessionId: 'native-1',
              state: 'open',
            },
          },
        },
        connection.signal
      );
      expect(getPendingAcpElicitationRequests('session-1')[0].expiresAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(86_400_000);
      await expectStillPending(response);
      connection.abort();
      await expect(response).resolves.toEqual({ action: 'cancel' });
    } finally {
      vi.useRealTimers();
    }
  });
});
