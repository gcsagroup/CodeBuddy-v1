// Bounded diagnostics only. These observations never decide load, permission or run state.
interface LoadObservation {
  id: string;
  started: number;
  updates: number;
  processingMs: number;
  longestUpdateMs: number;
  firstUpdateMs?: number;
  lastUpdateMs?: number;
}

const observations = new Map<string, LoadObservation>();
let nextLoad = 0;
type Fields = Record<string, string | number | boolean | null>;

export function beginSessionLoadTiming(sessionId: string, source: string): void {
  observations.delete(sessionId);
  while (observations.size >= 16) observations.delete(observations.keys().next().value!);
  observations.set(sessionId, {
    id: `${Date.now()}-${++nextLoad}`,
    started: globalThis.performance.now(),
    updates: 0,
    processingMs: 0,
    longestUpdateMs: 0,
  });
  traceSessionLoad(sessionId, 'open', { source });
}

export function ensureSessionLoadTiming(sessionId: string): void {
  if (!observations.has(sessionId)) beginSessionLoadTiming(sessionId, 'controller');
}

export function recordSessionReplay(sessionId: string, started: number): void {
  const observation = observations.get(sessionId);
  if (!observation) return;
  const now = globalThis.performance.now();
  observation.firstUpdateMs ??= started - observation.started;
  observation.lastUpdateMs = now - observation.started;
  observation.updates++;
  const processingMs = now - started;
  observation.processingMs += processingMs;
  observation.longestUpdateMs = Math.max(observation.longestUpdateMs, processingMs);
}

export function traceSessionLoad(sessionId: string, stage: string, fields: Fields = {}): void {
  const observation = observations.get(sessionId);
  if (!observation) return;
  try {
    window.electron?.logInfo(
      JSON.stringify({
        tag: 'session_load_timing',
        session_id: sessionId,
        load_id: observation.id,
        stage,
        at_ms: Date.now(),
        elapsed_ms: Math.round(globalThis.performance.now() - observation.started),
        ...fields,
      })
    );
  } catch {
    /* Logging cannot prevent opening a conversation. */
  }
}

export function traceSessionReplayComplete(sessionId: string, messageCount: number): void {
  const observation = observations.get(sessionId);
  if (!observation) return;
  traceSessionLoad(sessionId, 'store_ready', {
    messages: messageCount,
    updates: observation.updates,
    processing_ms: Math.round(observation.processingMs),
    longest_update_ms: Math.round(observation.longestUpdateMs),
    first_update_ms: Math.round(observation.firstUpdateMs ?? 0),
    last_update_ms: Math.round(observation.lastUpdateMs ?? 0),
  });
}

export function finishSessionLoadTiming(
  sessionId: string,
  stage: string,
  fields: Fields = {}
): void {
  traceSessionLoad(sessionId, stage, fields);
  observations.delete(sessionId);
}
