import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationSchema,
} from '@agentclientprotocol/sdk';
import { v7 as uuidv7 } from 'uuid';
import { acpChatSessionActions, acpElicitationUserInputRequestId } from './chatSessionStore';

type SessionScopedFormElicitationRequest = CreateElicitationRequest & {
  mode: 'form';
  sessionId: string;
  requestedSchema: ElicitationSchema;
};

export interface AcpElicitationRequest {
  id: string;
  sessionId: string;
  request: SessionScopedFormElicitationRequest;
  expiresAt?: number;
  nativeQuestion?: { callId: string; nativeSessionId: string };
  continued?: boolean;
}

interface PendingElicitationRequest {
  request: AcpElicitationRequest;
  responseAccepted?: boolean;
  resolve?: (response: CreateElicitationResponse) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
}

const pendingRequests = new Map<string, PendingElicitationRequest>();
export const ACP_ELICITATION_TIMEOUT_SECONDS = 300;

// Read the actual response registry, not action-required messages replayed from history.
export function getPendingAcpElicitationRequests(sessionId: string): AcpElicitationRequest[] {
  return [...pendingRequests.values()]
    .filter((pending) => pending.request.sessionId === sessionId && !pending.responseAccepted)
    .map((pending) => pending.request);
}

export async function requestAcpElicitation(
  request: CreateElicitationRequest,
  signal?: globalThis.AbortSignal
): Promise<CreateElicitationResponse> {
  if (!isSessionScopedFormElicitation(request)) {
    return cancelledElicitationResponse();
  }

  if (signal?.aborted) return cancelledElicitationResponse();
  const native = nativeQuestion(request);
  const elicitationRequest: AcpElicitationRequest = {
    id: native ? nativeQuestionId(native) : `acp_elicitation_${uuidv7()}`,
    sessionId: request.sessionId,
    request,
    ...(native
      ? {
          nativeQuestion: native,
          ...(native.remainingMs === undefined
            ? {}
            : { expiresAt: Date.now() + native.remainingMs }),
        }
      : { expiresAt: Date.now() + ACP_ELICITATION_TIMEOUT_SECONDS * 1000 }),
  };
  const key = elicitationRequestKey(elicitationRequest.sessionId, elicitationRequest.id);

  return new Promise<CreateElicitationResponse>((resolve) => {
    const timeoutId = native
      ? undefined
      : setTimeout(() => {
          const pending = pendingRequests.get(key);
          if (!pending) {
            return;
          }

          pendingRequests.delete(key);
          acpChatSessionActions.setElicitationStatus(
            elicitationRequest.sessionId,
            elicitationRequest.id,
            'expired'
          );
          acpChatSessionActions.resolveUserInputRequest(
            elicitationRequest.sessionId,
            acpElicitationUserInputRequestId(elicitationRequest.id)
          );
          pending.resolve?.({ action: 'cancel', _meta: { codepro: { reason: 'expired' } } });
          pending.dispose?.();
        }, ACP_ELICITATION_TIMEOUT_SECONDS * 1000);

    const previous = pendingRequests.get(key);
    previous?.resolve?.(cancelledElicitationResponse());
    previous?.dispose?.();
    clearTimeout(previous?.timeoutId);
    const abort = () => cancelAcpElicitationRequest(request.sessionId, elicitationRequest.id);
    signal?.addEventListener('abort', abort, { once: true });
    pendingRequests.set(key, {
      request: elicitationRequest,
      resolve,
      timeoutId,
      dispose: () => signal?.removeEventListener('abort', abort),
    });
    acpChatSessionActions.applyElicitationRequest(elicitationRequest);
  });
}

export function resolveAcpElicitationRequest(
  sessionId: string,
  elicitationId: string,
  userData: Record<string, unknown>
): boolean {
  const key = elicitationRequestKey(sessionId, elicitationId);
  const pending = pendingRequests.get(key);
  if (!pending?.resolve) {
    return false;
  }

  pendingRequests.delete(key);
  clearTimeout(pending.timeoutId);
  pending.dispose?.();
  acpChatSessionActions.setElicitationStatus(sessionId, elicitationId, 'submitted');
  acpChatSessionActions.resolveUserInputRequest(
    sessionId,
    acpElicitationUserInputRequestId(elicitationId)
  );
  pending.resolve(acceptedElicitationResponse(userData));
  return true;
}

export function cancelAcpElicitationRequest(sessionId: string, elicitationId: string): boolean {
  const key = elicitationRequestKey(sessionId, elicitationId);
  const pending = pendingRequests.get(key);
  if (!pending) {
    return false;
  }

  pendingRequests.delete(key);
  clearTimeout(pending.timeoutId);
  pending.dispose?.();
  acpChatSessionActions.setElicitationStatus(sessionId, elicitationId, 'cancelled');
  acpChatSessionActions.resolveUserInputRequest(
    sessionId,
    acpElicitationUserInputRequestId(elicitationId)
  );
  pending.resolve?.(cancelledElicitationResponse());
  return true;
}

export function cancelAcpElicitationRequestsForSession(sessionId: string): void {
  for (const [key, pending] of pendingRequests) {
    if (pending.request.sessionId === sessionId) {
      pendingRequests.delete(key);
      clearTimeout(pending.timeoutId);
      pending.dispose?.();
      acpChatSessionActions.setElicitationStatus(sessionId, pending.request.id, 'cancelled');
      acpChatSessionActions.resolveUserInputRequest(
        sessionId,
        acpElicitationUserInputRequestId(pending.request.id)
      );
      pending.resolve?.(cancelledElicitationResponse());
    }
  }
}

function nativeQuestion(request: CreateElicitationRequest) {
  const value = request._meta?.['codebuddy/question'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('callId' in value) ||
    typeof value.callId !== 'string' ||
    !('nativeSessionId' in value) ||
    typeof value.nativeSessionId !== 'string'
  )
    return;
  return {
    callId: value.callId,
    nativeSessionId: value.nativeSessionId,
    ...('remainingMs' in value &&
    typeof value.remainingMs === 'number' &&
    Number.isFinite(value.remainingMs) &&
    value.remainingMs >= 0
      ? { remainingMs: value.remainingMs }
      : {}),
  };
}

function nativeQuestionId(value: { nativeSessionId: string; callId: string }) {
  return `native_question:${value.nativeSessionId}:${value.callId}`;
}

// Presentation cache of the native projection, never a second pending-question ledger.
export function applyNativeQuestionSnapshot(
  sessionId: string,
  value: unknown,
  signal?: globalThis.AbortSignal
): void {
  if (signal?.aborted) return;
  if (
    !value ||
    typeof value !== 'object' ||
    !('active' in value) ||
    !Array.isArray(value.active) ||
    !('settled' in value) ||
    !Array.isArray(value.settled)
  )
    return;
  const active = new Set<string>();
  for (const item of value.active) {
    if (
      !item ||
      (item.state !== 'open' && item.state !== 'continued') ||
      !item.request ||
      !isSessionScopedFormElicitation(item.request) ||
      item.request.sessionId !== sessionId
    )
      continue;
    const native = nativeQuestion(item.request);
    if (!native || native.callId !== item.callId) continue;
    const id = nativeQuestionId(native),
      key = elicitationRequestKey(sessionId, id);
    active.add(key);
    const previous = pendingRequests.get(key);
    if (item.state === 'open') continue; // Only a live ACP request can answer an open tool call.
    // Native admission can lag behind the reply acknowledgement. Do not show
    // the same bubble again while that accepted reply is still in the inbox.
    if (previous?.responseAccepted) continue;
    previous?.resolve?.(cancelledElicitationResponse());
    previous?.dispose?.();
    clearTimeout(previous?.timeoutId);
    const request: AcpElicitationRequest = {
      id,
      sessionId,
      request: item.request,
      nativeQuestion: native,
      continued: true,
    };
    const abort = () => cancelAcpElicitationRequest(sessionId, id);
    signal?.addEventListener('abort', abort, { once: true });
    pendingRequests.set(key, {
      request,
      dispose: () => signal?.removeEventListener('abort', abort),
    });
    acpChatSessionActions.applyElicitationRequest(request);
    acpChatSessionActions.resolveUserInputRequest(sessionId, acpElicitationUserInputRequestId(id));
  }
  for (const [key, pending] of pendingRequests) {
    if (
      pending.request.sessionId !== sessionId ||
      !pending.request.nativeQuestion ||
      active.has(key)
    )
      continue;
    const settled = value.settled.find(
      (item) => item?.callId === pending.request.nativeQuestion?.callId
    );
    cancelAcpElicitationRequest(sessionId, pending.request.id);
    if (settled && !settled.skipped)
      acpChatSessionActions.setElicitationStatus(sessionId, pending.request.id, 'submitted');
  }
}

export async function submitAcpElicitationResponse(
  sessionId: string,
  id: string,
  data: Record<string, unknown>,
  action: 'accept' | 'cancel'
): Promise<boolean> {
  const pending = pendingRequests.get(elicitationRequestKey(sessionId, id));
  if (!pending || pending.responseAccepted) return false;
  if (!pending.request.continued)
    return action === 'cancel'
      ? cancelAcpElicitationRequest(sessionId, id)
      : resolveAcpElicitationRequest(sessionId, id, data);
  const { getAcpClient } = await import('./acpConnection');
  const client = await getAcpClient();
  const response = await client.extMethod('_goose/unstable/session/questions/answer', {
    sessionId,
    callId: pending.request.nativeQuestion?.callId,
    nativeSessionId: pending.request.nativeQuestion?.nativeSessionId,
    response:
      action === 'cancel' ? cancelledElicitationResponse() : acceptedElicitationResponse(data),
  });
  if (response.accepted !== true) return false;
  // The native reply may have been admitted before this RPC acknowledgement.
  const current = pendingRequests.get(elicitationRequestKey(sessionId, id));
  if (current) {
    current.responseAccepted = true;
    acpChatSessionActions.setElicitationStatus(
      sessionId,
      id,
      action === 'accept' ? 'submitted' : 'cancelled'
    );
  }
  return true;
}

function isSessionScopedFormElicitation(
  request: CreateElicitationRequest
): request is SessionScopedFormElicitationRequest {
  return request.mode === 'form' && 'sessionId' in request && typeof request.sessionId === 'string';
}

function acceptedElicitationResponse(userData: Record<string, unknown>): CreateElicitationResponse {
  return {
    action: 'accept',
    content: userData as Record<string, ElicitationContentValue>,
  };
}

function cancelledElicitationResponse(): CreateElicitationResponse {
  return { action: 'cancel' };
}

function elicitationRequestKey(sessionId: string, elicitationId: string): string {
  return `${sessionId}\u0000${elicitationId}`;
}
