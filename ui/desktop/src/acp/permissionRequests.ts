import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Permission } from '../types/permissions';
import { BUSINESS_SESSION_OPTION, readBusinessApproval } from '../types/businessApproval';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  acpPermissionUserInputRequestId,
} from './chatSessionStore';

interface PendingPermissionRequest {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  runId: string | null;
  sourceUserMessageId: string | null;
  dispose?: () => void;
}

const pendingRequests = new Map<string, PendingPermissionRequest>();
const listeners = new Set<() => void>();

export function isAcpPermissionRequestPending(sessionId: string, toolCallId: string): boolean {
  return pendingRequests.has(permissionRequestKey(sessionId, toolCallId));
}

export function subscribeAcpPermissionRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

// History replay replaces rendered messages, but an unanswered RPC is still
// live. Re-project only those requests, without resolving or reissuing them.
export function restoreAcpPermissionRequestsForSession(sessionId: string): void {
  for (const pending of pendingRequests.values()) {
    if (pending.request.sessionId === sessionId) {
      acpChatSessionActions.applyPermissionRequest(pending.request);
    }
  }
}

export async function requestAcpPermission(
  request: RequestPermissionRequest,
  signal?: AbortController['signal']
): Promise<RequestPermissionResponse> {
  if (signal?.aborted) return cancelledPermissionResponse();

  // The Host owns approval policy. A request that reaches the renderer still
  // needs a decision, even when its display name matches a native control tool.

  const key = permissionRequestKey(request.sessionId, request.toolCall.toolCallId);
  const previous = pendingRequests.get(key);
  if (previous) {
    settlePermissionRequest(key, previous, cancelledPermissionResponse());
  }

  return new Promise<RequestPermissionResponse>((resolve) => {
    const pending: PendingPermissionRequest = {
      request,
      resolve,
      runId: acpChatSessionStore.getSnapshot(request.sessionId)?.activeRunId ?? null,
      sourceUserMessageId: acpChatSessionStore.getActivePromptSourceUserMessageId(
        request.sessionId
      ),
    };
    pendingRequests.set(key, pending);
    if (signal) {
      const abort = () => settlePermissionRequest(key, pending, cancelledPermissionResponse());
      signal.addEventListener('abort', abort, { once: true });
      pending.dispose = () => signal.removeEventListener('abort', abort);
    }
    acpChatSessionActions.applyPermissionRequest(request);
    notifyListeners();
  });
}

export function resolveAcpPermissionRequest(
  sessionId: string,
  toolCallId: string,
  action: Permission
): boolean {
  const key = permissionRequestKey(sessionId, toolCallId);
  const pending = pendingRequests.get(key);
  if (!pending) {
    return false;
  }

  const response = permissionResponseForAction(pending.request, action);
  if (!response) {
    return false;
  }

  settlePermissionRequest(key, pending, response);
  return true;
}

function settlePermissionRequest(
  key: string,
  pending: PendingPermissionRequest,
  response: RequestPermissionResponse
): void {
  if (pendingRequests.get(key) !== pending) return;
  pendingRequests.delete(key);
  pending.dispose?.();
  acpChatSessionActions.resolveUserInputRequest(
    pending.request.sessionId,
    acpPermissionUserInputRequestId(pending.request.toolCall.toolCallId)
  );
  pending.resolve(response);
  notifyListeners();
}

export function cancelAcpPermissionRequestsForSession(sessionId: string): void {
  for (const [key, pending] of pendingRequests) {
    if (pending.request.sessionId === sessionId) {
      settlePermissionRequest(key, pending, cancelledPermissionResponse());
    }
  }
}

export function expireAcpPermissionRequestForTool(
  sessionId: string,
  toolCallId: string,
  runId?: string,
  includesChildSessionId = false
): void {
  // Native child receipts use `${childSessionId}:${callId}`; permission RPCs
  // use the original callId on the parent transport. This is protocol identity,
  // never a match against the tool title or result prose.
  const exactKey = permissionRequestKey(sessionId, toolCallId);
  const key =
    pendingRequests.has(exactKey) || !includesChildSessionId
      ? exactKey
      : permissionRequestKey(sessionId, toolCallId.slice(toolCallId.lastIndexOf(':') + 1));
  const pending = pendingRequests.get(key);
  if (pending && (!runId || !pending.runId || pending.runId === runId)) {
    settlePermissionRequest(key, pending, cancelledPermissionResponse());
  }
}

export function expireAcpPermissionRequestsForTurn(
  sessionId: string,
  runId: string,
  sourceUserMessageId: string
): void {
  for (const [key, pending] of pendingRequests) {
    if (
      pending.request.sessionId === sessionId &&
      (pending.runId === null || pending.runId === runId) &&
      pending.sourceUserMessageId === sourceUserMessageId
    ) {
      settlePermissionRequest(key, pending, cancelledPermissionResponse());
    }
  }
}

function permissionResponseForAction(
  request: RequestPermissionRequest,
  action: Permission
): RequestPermissionResponse | undefined {
  if (action === 'cancel') {
    return cancelledPermissionResponse();
  }

  const optionId = permissionOptionIdForAction(request, action);
  if (!optionId) {
    return undefined;
  }

  return {
    outcome: {
      outcome: 'selected',
      optionId,
    },
  };
}

function permissionOptionIdForAction(
  request: RequestPermissionRequest,
  action: Permission
): string | undefined {
  const kind = permissionOptionKindForAction(action);
  if (!kind) {
    return undefined;
  }

  return request.options.find(
    (candidate) =>
      candidate.kind === kind &&
      (candidate.optionId !== BUSINESS_SESSION_OPTION || readBusinessApproval(request._meta))
  )?.optionId;
}

function permissionOptionKindForAction(action: Permission) {
  switch (action) {
    case 'allow_once':
      return 'allow_once';
    case 'always_allow':
      return 'allow_always';
    case 'deny_once':
      return 'reject_once';
    case 'always_deny':
      return 'reject_always';
    case 'cancel':
      return undefined;
  }
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return {
    outcome: {
      outcome: 'cancelled',
    },
  };
}

function permissionRequestKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}
