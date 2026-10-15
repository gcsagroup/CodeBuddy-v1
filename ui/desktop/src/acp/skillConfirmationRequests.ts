import type {
  RequestSkillManagementConfirmation_unstable,
  SkillManagementConfirmationResponse_unstable,
} from '@aaif/goose-sdk';

export type SkillManagementConfirmationRequest = RequestSkillManagementConfirmation_unstable;

export interface PendingSkillManagementConfirmation {
  request: SkillManagementConfirmationRequest;
  resolve: (response: SkillManagementConfirmationResponse_unstable) => void;
}

const pendingRequests = new Map<string, PendingSkillManagementConfirmation>();
const listeners = new Set<() => void>();
let snapshot: SkillManagementConfirmationRequest[] = [];

function emit(): void {
  snapshot = Array.from(pendingRequests.values(), (pending) => pending.request);
  for (const listener of listeners) listener();
}

export function subscribeSkillManagementConfirmations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSkillManagementConfirmationsSnapshot(): SkillManagementConfirmationRequest[] {
  return snapshot;
}

export function requestSkillManagementConfirmation(
  request: SkillManagementConfirmationRequest
): Promise<SkillManagementConfirmationResponse_unstable> {
  return new Promise((resolve) => {
    pendingRequests.set(request.previewToken, { request, resolve });
    emit();
  });
}

export function resolveSkillManagementConfirmation(
  previewToken: string,
  decision: 'confirm' | 'cancel'
): boolean {
  const pending = pendingRequests.get(previewToken);
  if (!pending) return false;
  pendingRequests.delete(previewToken);
  emit();
  pending.resolve({ decision, nonce: pending.request.nonce });
  return true;
}
