import type {
  RecipeParameterDto,
  RecipeParamsResponse_unstable,
  RequestRecipeParams_unstable,
} from '@aaif/goose-sdk';
import { v7 as uuidv7 } from 'uuid';

export interface AcpRecipeParamRequest {
  id: string;
  sessionId: string;
  parameters: RecipeParameterDto[];
  initialValues?: Record<string, string>;
}

interface PendingRecipeParamRequest {
  request: AcpRecipeParamRequest;
  resolve: (response: RecipeParamsResponse_unstable) => void;
  cleanup: () => void;
}

const pendingRequests = new Map<string, PendingRecipeParamRequest>();
const listeners = new Set<() => void>();
let snapshot: AcpRecipeParamRequest[] = [];

function emit(): void {
  snapshot = Array.from(pendingRequests.values(), (pending) => pending.request);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAcpRecipeParamRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAcpRecipeParamRequestsSnapshot(): AcpRecipeParamRequest[] {
  return snapshot;
}

function configuredParameterValues(): Record<string, string> {
  const configured = window.appConfig?.get('recipeParameters') as
    | Record<string, string>
    | undefined;
  return configured ?? {};
}

export async function requestAcpRecipeParams(
  request: RequestRecipeParams_unstable,
  signal?: AbortController['signal']
): Promise<RecipeParamsResponse_unstable> {
  if (signal?.aborted) return { action: 'cancel' };
  const initialValues = configuredParameterValues();
  const paramRequest: AcpRecipeParamRequest = {
    id: `acp_recipe_params_${uuidv7()}`,
    sessionId: request.sessionId,
    parameters: request.parameters,
    initialValues,
  };

  return new Promise<RecipeParamsResponse_unstable>((resolve) => {
    const cancel = () => cancelAcpRecipeParamRequest(paramRequest.id);
    pendingRequests.set(paramRequest.id, {
      request: paramRequest,
      resolve,
      cleanup: () => signal?.removeEventListener('abort', cancel),
    });
    signal?.addEventListener('abort', cancel, { once: true });
    emit();
  });
}

export function resolveAcpRecipeParamRequest(id: string, values: Record<string, string>): boolean {
  const pending = pendingRequests.get(id);
  if (!pending) {
    return false;
  }
  pendingRequests.delete(id);
  pending.cleanup();
  emit();
  pending.resolve({ action: 'submit', values });
  return true;
}

export function cancelAcpRecipeParamRequest(id: string): void {
  const pending = pendingRequests.get(id);
  if (!pending) {
    return;
  }
  pendingRequests.delete(id);
  pending.cleanup();
  emit();
  pending.resolve({ action: 'cancel' });
}
