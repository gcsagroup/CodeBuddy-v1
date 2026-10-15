import type { CodeProRunSnapshot } from '@aaif/goose-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCodeProRunSnapshot,
  clearAllCodeProRunProjections,
  getCodeProRunProjection,
  listObservedCodeProRuns,
  observeCodeProRun,
  subscribeToCodeProRun,
} from './runProjection';

function snapshot(overrides: Partial<CodeProRunSnapshot> = {}): CodeProRunSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    state: 'running',
    goal: 'Fix the bug',
    planRevision: 1,
    lastSequence: 4,
    coordinator: {
      requestedMode: 'authoritative',
      effectiveMode: 'shadow',
      qualification: 'missing',
      reason: 'No exact live qualification record',
    },
    ...overrides,
  };
}

afterEach(clearAllCodeProRunProjections);

describe('CodePro run projection store', () => {
  it('normalizes optional collections and notifies exact run subscribers', () => {
    const listener = vi.fn();
    subscribeToCodeProRun('session-1', 'run-1', listener);
    subscribeToCodeProRun('session-2', 'run-1', vi.fn());

    const projection = applyCodeProRunSnapshot(snapshot());

    expect(projection.tasks).toEqual([]);
    expect(projection.effects).toEqual([]);
    expect(listener).toHaveBeenCalledWith(projection);
    expect(getCodeProRunProjection('session-2', 'run-1')).toBeUndefined();
  });

  it('rejects sequence regression and same-sequence conflicts', () => {
    applyCodeProRunSnapshot(snapshot());

    expect(() => applyCodeProRunSnapshot(snapshot({ lastSequence: 3 }))).toThrow(/regressed/);
    expect(() => applyCodeProRunSnapshot(snapshot({ state: 'paused' }))).toThrow(/conflicting/);
    expect(getCodeProRunProjection('session-1', 'run-1')?.state).toBe('running');
  });

  it('treats an identical replay as idempotent', () => {
    const listener = vi.fn();
    subscribeToCodeProRun('session-1', 'run-1', listener);
    const first = applyCodeProRunSnapshot(snapshot());
    const replay = applyCodeProRunSnapshot(snapshot());

    expect(replay).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts operational convergence at the same event sequence', () => {
    const listener = vi.fn();
    subscribeToCodeProRun('session-1', 'run-1', listener);
    applyCodeProRunSnapshot(
      snapshot({
        effects: [
          {
            effectId: 'effect-1',
            triggerEventId: 'event-4',
            state: 'pending',
            summary: 'Stop worker',
            requiresResolution: false,
          },
        ],
      })
    );

    const converged = applyCodeProRunSnapshot(
      snapshot({
        effects: [
          {
            effectId: 'effect-1',
            triggerEventId: 'event-4',
            state: 'completed',
            summary: 'Stop worker',
            requiresResolution: false,
          },
        ],
        recovery: {
          truncatedEventBytes: 0,
          truncatedEffectBytes: 0,
          pendingEffects: 0,
          uncertainEffects: 0,
          abandonedEffects: 0,
        },
      })
    );

    expect(converged.effects[0]?.state).toBe('completed');
    expect(getCodeProRunProjection('session-1', 'run-1')).toBe(converged);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported schema versions without replacing state', () => {
    applyCodeProRunSnapshot(snapshot());
    expect(() => applyCodeProRunSnapshot(snapshot({ schemaVersion: 2 }))).toThrow(/Unsupported/);
    expect(getCodeProRunProjection('session-1', 'run-1')?.schemaVersion).toBe(1);
  });

  it('tracks observed session and run pairs for reconnect hydration', () => {
    const stopObserving = observeCodeProRun('session-1', 'run-1');
    expect(listObservedCodeProRuns()).toEqual([{ sessionId: 'session-1', runId: 'run-1' }]);
    stopObserving();
    expect(listObservedCodeProRuns()).toEqual([]);
  });
});
