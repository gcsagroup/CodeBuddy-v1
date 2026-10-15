import type { CodeProRunNotification_unstable, CodeProRunSnapshot } from '@aaif/goose-sdk';

export const CODEPRO_RUN_SCHEMA_VERSION = 1;

export type CodeProRunProjection = Omit<
  CodeProRunSnapshot,
  'agents' | 'effects' | 'recentEvents' | 'recovery' | 'tasks'
> & {
  agents: NonNullable<CodeProRunSnapshot['agents']>;
  effects: NonNullable<CodeProRunSnapshot['effects']>;
  recentEvents: NonNullable<CodeProRunSnapshot['recentEvents']>;
  recovery: NonNullable<CodeProRunSnapshot['recovery']>;
  tasks: NonNullable<CodeProRunSnapshot['tasks']>;
};

export type CodeProRunProjectionListener = (projection: CodeProRunProjection | undefined) => void;

type RunKey = `${string}\u0000${string}`;

const projections = new Map<RunKey, CodeProRunProjection>();
const listeners = new Map<RunKey, Set<CodeProRunProjectionListener>>();
const observedRuns = new Map<RunKey, { runId: string; sessionId: string }>();

export class CodeProRunProjectionError extends Error {}

export function applyCodeProRunSnapshot(snapshot: CodeProRunSnapshot): CodeProRunProjection {
  const normalized = normalizeSnapshot(snapshot);
  const key = runKey(normalized.sessionId, normalized.runId);
  const current = projections.get(key);

  if (current && normalized.lastSequence < current.lastSequence) {
    throw new CodeProRunProjectionError(
      `CodePro run sequence regressed from ${current.lastSequence} to ${normalized.lastSequence}`
    );
  }
  if (current && normalized.lastSequence === current.lastSequence) {
    if (!sameEventProjection(current, normalized)) {
      throw new CodeProRunProjectionError(
        `CodePro run sequence ${normalized.lastSequence} has conflicting projections`
      );
    }
    if (sameProjection(current, normalized)) return current;
  }

  projections.set(key, normalized);
  notify(key, normalized);
  return normalized;
}

export function applyCodeProRunNotification(
  notification: CodeProRunNotification_unstable
): CodeProRunProjection {
  return applyCodeProRunSnapshot(notification.snapshot);
}

export function getCodeProRunProjection(
  sessionId: string,
  runId: string
): CodeProRunProjection | undefined {
  return projections.get(runKey(sessionId, runId));
}

export function observeCodeProRun(sessionId: string, runId: string): () => void {
  validateIdentity('sessionId', sessionId);
  validateIdentity('runId', runId);
  const key = runKey(sessionId, runId);
  observedRuns.set(key, { sessionId, runId });
  return () => observedRuns.delete(key);
}

export function listObservedCodeProRuns(): Array<{ runId: string; sessionId: string }> {
  return [...observedRuns.values()];
}

export function subscribeToCodeProRun(
  sessionId: string,
  runId: string,
  listener: CodeProRunProjectionListener
): () => void {
  const key = runKey(sessionId, runId);
  const subscribers = listeners.get(key) ?? new Set<CodeProRunProjectionListener>();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(key);
  };
}

export function clearCodeProRunProjection(sessionId: string, runId: string): void {
  const key = runKey(sessionId, runId);
  projections.delete(key);
  notify(key, undefined);
}

export function clearAllCodeProRunProjections(): void {
  const keys = [...projections.keys()];
  projections.clear();
  observedRuns.clear();
  for (const key of keys) notify(key, undefined);
}

function normalizeSnapshot(snapshot: CodeProRunSnapshot): CodeProRunProjection {
  if (snapshot.schemaVersion !== CODEPRO_RUN_SCHEMA_VERSION) {
    throw new CodeProRunProjectionError(
      `Unsupported CodePro run schema version ${snapshot.schemaVersion}`
    );
  }
  validateIdentity('sessionId', snapshot.sessionId);
  validateIdentity('runId', snapshot.runId);
  if (!Number.isSafeInteger(snapshot.lastSequence) || snapshot.lastSequence < 1) {
    throw new CodeProRunProjectionError('CodePro run lastSequence must be a positive integer');
  }
  return {
    ...snapshot,
    tasks: snapshot.tasks ?? [],
    agents: snapshot.agents ?? [],
    recentEvents: snapshot.recentEvents ?? [],
    effects: snapshot.effects ?? [],
    recovery: snapshot.recovery ?? {
      truncatedEventBytes: 0,
      truncatedEffectBytes: 0,
      pendingEffects: 0,
      uncertainEffects: 0,
      abandonedEffects: 0,
    },
  };
}

function validateIdentity(field: string, value: string): void {
  if (!value.trim()) throw new CodeProRunProjectionError(`${field} must not be empty`);
}

function runKey(sessionId: string, runId: string): RunKey {
  return `${sessionId}\u0000${runId}`;
}

function sameProjection(left: CodeProRunProjection, right: CodeProRunProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEventProjection(left: CodeProRunProjection, right: CodeProRunProjection): boolean {
  return JSON.stringify(eventProjection(left)) === JSON.stringify(eventProjection(right));
}

function eventProjection(projection: CodeProRunProjection) {
  const {
    effects: _effects,
    recovery: _recovery,
    coordinator: _coordinator,
    ...eventBackedProjection
  } = projection;
  return eventBackedProjection;
}

function notify(key: RunKey, projection: CodeProRunProjection | undefined): void {
  for (const listener of listeners.get(key) ?? []) listener(projection);
}
