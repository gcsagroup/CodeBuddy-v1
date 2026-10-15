import type { CodeProRunSnapshot } from '@aaif/goose-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeProRunCommands, refreshObservedCodeProRuns } from './runCommands';
import {
  applyCodeProRunSnapshot,
  clearAllCodeProRunProjections,
  getCodeProRunProjection,
  observeCodeProRun,
} from './runProjection';

function snapshot(lastSequence: number, state: CodeProRunSnapshot['state'] = 'running') {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    state,
    goal: 'Fix the bug',
    planRevision: 1,
    lastSequence,
    coordinator: {
      requestedMode: 'shadow' as const,
      effectiveMode: 'shadow' as const,
      qualification: 'not_required' as const,
      reason: 'Shadow mode does not require qualification',
    },
  } satisfies CodeProRunSnapshot;
}

afterEach(clearAllCodeProRunProjections);

describe('CodePro run commands', () => {
  it('sends the last backend sequence and applies only the returned projection', async () => {
    applyCodeProRunSnapshot(snapshot(4));
    const client = {
      codeproRunControl_unstable: vi.fn().mockResolvedValue({
        commandId: 'server-command',
        previousSequence: 4,
        committedEventIds: ['event:5'],
        snapshot: snapshot(6, 'paused'),
      }),
    };
    const commands = createCodeProRunCommands(async () => ({ goose: client as never }));

    const pending = commands.control('session-1', 'run-1', {
      type: 'pause_run',
      reason: 'Review progress',
    });
    expect(getCodeProRunProjection('session-1', 'run-1')?.state).toBe('running');
    await expect(pending).resolves.toMatchObject({ state: 'paused', lastSequence: 6 });
    expect(client.codeproRunControl_unstable).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSequence: 4, sessionId: 'session-1', runId: 'run-1' })
    );
  });

  it('leaves confirmed state untouched when the backend rejects a command', async () => {
    applyCodeProRunSnapshot(snapshot(4));
    const client = {
      codeproRunControl_unstable: vi.fn().mockRejectedValue(new Error('stale sequence')),
    };
    const commands = createCodeProRunCommands(async () => ({ goose: client as never }));

    await expect(
      commands.control('session-1', 'run-1', {
        type: 'emergency_stop',
        reason: 'User requested stop',
      })
    ).rejects.toThrow('stale sequence');
    expect(getCodeProRunProjection('session-1', 'run-1')?.state).toBe('running');
  });

  it('hydrates observed runs with read-only requests after reconnect', async () => {
    observeCodeProRun('session-1', 'run-1');
    const client = {
      codeproRunGet_unstable: vi.fn().mockResolvedValue({ snapshot: snapshot(8, 'paused') }),
    };

    await refreshObservedCodeProRuns(client as never);

    expect(client.codeproRunGet_unstable).toHaveBeenCalledWith({
      schemaVersion: 1,
      sessionId: 'session-1',
      runId: 'run-1',
    });
    expect(getCodeProRunProjection('session-1', 'run-1')?.lastSequence).toBe(8);
  });

  it('abandons a hung control request and lets the next poll use a fresh connection', async () => {
    vi.useFakeTimers();
    const hungClient = {
      codeproRunGet_unstable: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const recoveredClient = {
      codeproRunGet_unstable: vi.fn().mockResolvedValue({ snapshot: snapshot(14, 'completed') }),
    };
    const clientProvider = vi
      .fn()
      .mockResolvedValueOnce({ goose: hungClient as never })
      .mockResolvedValueOnce({ goose: recoveredClient as never });
    const resetControlConnection = vi.fn();
    const commands = createCodeProRunCommands(clientProvider, resetControlConnection, 100);

    const first = commands.refresh('session-1', 'run-1');
    const rejected = expect(first).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;

    expect(resetControlConnection).toHaveBeenCalledOnce();
    await expect(commands.refresh('session-1', 'run-1')).resolves.toMatchObject({
      state: 'completed',
      lastSequence: 14,
    });
    expect(clientProvider).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
