import { useCallback, useEffect, useRef, useState } from 'react';
import { acpChatSessionController } from '../acp/chatSessionController';
import {
  acpChatSessionStore,
  subscribeToAcpChatSession,
  type AcpChatSessionSnapshot,
} from '../acp/chatSessionStore';
import { isAcpSessionLoadInFlight } from '../acp/sessions';
import { getTurnTerminalRecord, type TurnTerminalStatus } from '../types/turnTerminal';
import { codeProRunCommands } from './runCommands';
import {
  getCodeProRunProjection,
  observeCodeProRun,
  subscribeToCodeProRun,
  type CodeProRunProjection,
} from './runProjection';

const ACTIVE_RUN_REFRESH_INTERVAL_MS = 2_000;

function isTerminalRunState(state: CodeProRunProjection['state'] | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function terminalStatusForProjection(
  state: CodeProRunProjection['state']
): TurnTerminalStatus | undefined {
  if (state === 'completed' || state === 'failed' || state === 'cancelled') return state;
  return undefined;
}

function terminalEventType(state: CodeProRunProjection['state']): string | undefined {
  if (state === 'completed') return 'run_completed';
  if (state === 'failed') return 'run_failed';
  if (state === 'cancelled') return 'run_cancelled';
  return undefined;
}

function terminalOccurrenceKey(projection: CodeProRunProjection): string {
  const eventType = terminalEventType(projection.state);
  const terminalEvent = projection.recentEvents
    .filter((event) => event.eventType === eventType)
    .sort((left, right) => right.sequence - left.sequence)[0];
  return terminalEvent?.eventId ?? `sequence:${projection.lastSequence}`;
}

function hasMatchingTerminal(
  snapshot: AcpChatSessionSnapshot | undefined,
  projection: CodeProRunProjection,
  sourceUserMessageId?: string
): boolean {
  const expectedStatus = terminalStatusForProjection(projection.state);
  if (!expectedStatus) return false;
  return Boolean(
    snapshot?.messages.some((message) => {
      const terminal = getTurnTerminalRecord(message);
      return (
        terminal?.session_id === projection.sessionId &&
        terminal.run_id === projection.runId &&
        terminal.status === expectedStatus &&
        (sourceUserMessageId === undefined ||
          terminal.source_user_message_id === sourceUserMessageId)
      );
    })
  );
}

export function useCodeProRunProjection(sessionId: string, runId?: string | null) {
  const [projection, setProjection] = useState<CodeProRunProjection>();
  const [loadError, setLoadError] = useState<string>();
  const [manualRefreshGeneration, setManualRefreshGeneration] = useState(0);
  const completedTerminalReloadsRef = useRef(new Set<string>());
  const attemptedTerminalReloadsRef = useRef(new Set<string>());
  const refreshInFlightRef = useRef<
    | {
        sessionId: string;
        runId: string;
        promise: Promise<CodeProRunProjection | undefined>;
      }
    | undefined
  >(undefined);

  const refreshProjection = useCallback(() => {
    if (!sessionId || !runId) return Promise.resolve(undefined);
    if (
      refreshInFlightRef.current?.sessionId === sessionId &&
      refreshInFlightRef.current.runId === runId
    ) {
      return refreshInFlightRef.current.promise;
    }
    const pending = codeProRunCommands
      .refresh(sessionId, runId)
      .then((next) => {
        setLoadError(undefined);
        return next;
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
        return undefined;
      })
      .finally(() => {
        if (refreshInFlightRef.current?.promise === pending) refreshInFlightRef.current = undefined;
      });
    refreshInFlightRef.current = { sessionId, runId, promise: pending };
    return pending;
  }, [runId, sessionId]);

  const refresh = useCallback(async () => {
    const next = await refreshProjection();
    setManualRefreshGeneration((generation) => generation + 1);
    return next;
  }, [refreshProjection]);

  useEffect(() => {
    if (!sessionId || !runId) {
      setProjection(undefined);
      setLoadError(undefined);
      return;
    }
    setProjection(getCodeProRunProjection(sessionId, runId));
    const stopObserving = observeCodeProRun(sessionId, runId);
    const unsubscribe = subscribeToCodeProRun(sessionId, runId, setProjection);
    void refreshProjection();
    return () => {
      unsubscribe();
      stopObserving();
    };
  }, [refreshProjection, runId, sessionId]);

  useEffect(() => {
    if (!sessionId || !runId || isTerminalRunState(projection?.state)) return;
    const interval = window.setInterval(() => {
      void refreshProjection();
    }, ACTIVE_RUN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [projection?.state, refreshProjection, runId, sessionId]);

  useEffect(() => {
    if (
      !sessionId ||
      !runId ||
      !projection ||
      projection.sessionId !== sessionId ||
      projection.runId !== runId ||
      !isTerminalRunState(projection.state)
    ) {
      return;
    }

    const sourceUserMessageId =
      acpChatSessionStore.getActivePromptSourceUserMessageId(sessionId) ?? undefined;
    const occurrenceKey = terminalOccurrenceKey(projection);
    const terminalKey = `${sessionId}\u0000${runId}\u0000${projection.state}\u0000${occurrenceKey}`;
    const attemptKey = `${terminalKey}\u0000${projection.lastSequence}\u0000${manualRefreshGeneration}`;
    if (completedTerminalReloadsRef.current.has(terminalKey)) return;

    let cancelled = false;
    let unsubscribe = () => {};
    const evaluate = (snapshot: AcpChatSessionSnapshot | undefined) => {
      if (
        cancelled ||
        snapshot?.activePromptAttemptId != null ||
        isAcpSessionLoadInFlight(sessionId)
      ) {
        return;
      }
      if (
        sourceUserMessageId !== undefined &&
        hasMatchingTerminal(snapshot, projection, sourceUserMessageId)
      ) {
        completedTerminalReloadsRef.current.add(terminalKey);
        unsubscribe();
        return;
      }
      if (attemptedTerminalReloadsRef.current.has(attemptKey)) return;
      attemptedTerminalReloadsRef.current.add(attemptKey);
      void acpChatSessionController.restoreSession(sessionId).then(() => {
        if (cancelled) return;
        const restored = acpChatSessionStore.getSnapshot(sessionId);
        if (hasMatchingTerminal(restored, projection, sourceUserMessageId)) {
          completedTerminalReloadsRef.current.add(terminalKey);
          unsubscribe();
        }
      });
    };

    unsubscribe = subscribeToAcpChatSession(sessionId, evaluate);
    evaluate(acpChatSessionStore.getSnapshot(sessionId));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [manualRefreshGeneration, projection, runId, sessionId]);

  return { loadError, projection, refresh };
}
