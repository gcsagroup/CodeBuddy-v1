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
  expiresAt: number;
}

interface PendingElicitationRequest {
  request: AcpElicitationRequest;
  resolve: (response: CreateElicitationResponse) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingElicitationRequest>();
export const ACP_ELICITATION_TIMEOUT_SECONDS = 300;

// Read the actual response registry, not action-required messages replayed from history.
export function getPendingAcpElicitationRequests(sessionId: string): AcpElicitationRequest[] {
  return [...pendingRequests.values()]
    .filter((pending) => pending.request.sessionId === sessionId)
    .map((pending) => pending.request);
}

export async function requestAcpElicitation(
  request: CreateElicitationRequest
): Promise<CreateElicitationResponse> {
  if (!isSessionScopedFormElicitation(request)) {
    return cancelledElicitationResponse();
  }

  const elicitationRequest: AcpElicitationRequest = {
    id: `acp_elicitation_${uuidv7()}`,
    sessionId: request.sessionId,
    request,
    expiresAt: Date.now() + ACP_ELICITATION_TIMEOUT_SECONDS * 1000,
  };
  const key = elicitationRequestKey(elicitationRequest.sessionId, elicitationRequest.id);

  return new Promise<CreateElicitationResponse>((resolve) => {
    const timeoutId = setTimeout(() => {
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
      pending.resolve({ action: 'cancel', _meta: { codepro: { reason: 'expired' } } });
    }, ACP_ELICITATION_TIMEOUT_SECONDS * 1000);

    pendingRequests.set(key, { request: elicitationRequest, resolve, timeoutId });
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
  if (!pending) {
    return false;
  }

  pendingRequests.delete(key);
  clearTimeout(pending.timeoutId);
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
  acpChatSessionActions.setElicitationStatus(sessionId, elicitationId, 'cancelled');
  acpChatSessionActions.resolveUserInputRequest(
    sessionId,
    acpElicitationUserInputRequestId(elicitationId)
  );
  pending.resolve(cancelledElicitationResponse());
  return true;
}

export function cancelAcpElicitationRequestsForSession(sessionId: string): void {
  for (const [key, pending] of pendingRequests) {
    if (pending.request.sessionId === sessionId) {
      pendingRequests.delete(key);
      clearTimeout(pending.timeoutId);
      acpChatSessionActions.setElicitationStatus(sessionId, pending.request.id, 'cancelled');
      acpChatSessionActions.resolveUserInputRequest(
        sessionId,
        acpElicitationUserInputRequestId(pending.request.id)
      );
      pending.resolve(cancelledElicitationResponse());
    }
  }
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
