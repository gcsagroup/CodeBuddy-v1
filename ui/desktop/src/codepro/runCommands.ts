import type {
  CodeProEffectResolution,
  CodeProRunControlAction,
  CodeProRunControlResponse_unstable,
  CodeProRunSnapshotResponse_unstable,
} from '@aaif/goose-sdk';
import { getAcpControlClient, resetAcpControlConnection } from '../acp/acpConnection';
import {
  applyCodeProRunSnapshot,
  getCodeProRunProjection,
  listObservedCodeProRuns,
  type CodeProRunProjection,
} from './runProjection';

interface CodeProControlClient {
  codeproEffectsResolve_unstable(params: {
    schemaVersion: number;
    sessionId: string;
    runId: string;
    effectId: string;
    resolution: CodeProEffectResolution;
  }): Promise<CodeProRunSnapshotResponse_unstable>;
  codeproRunControl_unstable(params: {
    schemaVersion: number;
    sessionId: string;
    commandId: string;
    runId: string;
    expectedSequence: number;
    action: CodeProRunControlAction;
  }): Promise<CodeProRunControlResponse_unstable>;
  codeproRunGet_unstable(params: {
    schemaVersion: number;
    sessionId: string;
    runId: string;
  }): Promise<CodeProRunSnapshotResponse_unstable>;
}

type ClientProvider = () => Promise<{ goose: CodeProControlClient }>;

const SCHEMA_VERSION = 1;
const RUN_GET_TIMEOUT_MS = 5_000;

class CodeProRunGetTimeoutError extends Error {}

export function createCodeProRunCommands(
  clientProvider: ClientProvider = getAcpControlClient,
  resetControlConnection: () => void = resetAcpControlConnection,
  refreshTimeoutMs: number = RUN_GET_TIMEOUT_MS
) {
  async function refresh(sessionId: string, runId: string): Promise<CodeProRunProjection> {
    const { goose } = await clientProvider();
    try {
      return await withTimeout(
        refreshWithClient(goose, sessionId, runId),
        refreshTimeoutMs,
        `CodePro run refresh timed out after ${refreshTimeoutMs}ms`
      );
    } catch (error) {
      if (error instanceof CodeProRunGetTimeoutError) resetControlConnection();
      throw error;
    }
  }

  async function control(
    sessionId: string,
    runId: string,
    action: CodeProRunControlAction
  ): Promise<CodeProRunProjection> {
    const current = getCodeProRunProjection(sessionId, runId) ?? (await refresh(sessionId, runId));
    const { goose } = await clientProvider();
    const response = await goose.codeproRunControl_unstable({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      commandId: createCommandId(),
      runId,
      expectedSequence: current.lastSequence,
      action,
    });
    return applyCodeProRunSnapshot(response.snapshot);
  }

  async function resolveEffect(
    sessionId: string,
    runId: string,
    effectId: string,
    resolution: CodeProEffectResolution
  ): Promise<CodeProRunProjection> {
    const { goose } = await clientProvider();
    const response = await goose.codeproEffectsResolve_unstable({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      runId,
      effectId,
      resolution,
    });
    return applyCodeProRunSnapshot(response.snapshot);
  }

  return { control, refresh, resolveEffect };
}

export async function refreshObservedCodeProRuns(client: CodeProControlClient): Promise<void> {
  await Promise.allSettled(
    listObservedCodeProRuns().map(({ sessionId, runId }) =>
      refreshWithClient(client, sessionId, runId)
    )
  );
}

async function refreshWithClient(
  client: CodeProControlClient,
  sessionId: string,
  runId: string
): Promise<CodeProRunProjection> {
  const response = await client.codeproRunGet_unstable({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runId,
  });
  return applyCodeProRunSnapshot(response.snapshot);
}

function createCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `command-${Date.now()}-${Math.random()}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new CodeProRunGetTimeoutError(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export const codeProRunCommands = createCodeProRunCommands();
