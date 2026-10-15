import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodeProRunProjection } from '../../codepro/runProjection';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProControlPlaneView } from './CodeProControlPlanePanel';

function projection(overrides: Partial<CodeProRunProjection> = {}): CodeProRunProjection {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    state: 'running',
    goal: 'Fix the bug',
    planRevision: 1,
    lastSequence: 9,
    tasks: [
      {
        taskId: 'task-1',
        name: 'Fix login',
        state: 'running',
        retryAttempts: 0,
        evidence: [],
      },
    ],
    agents: [{ agentId: 'agent-1', taskId: 'task-1', role: 'coder', state: 'running' }],
    recentEvents: [],
    effects: [],
    coordinator: {
      requestedMode: 'authoritative',
      effectiveMode: 'shadow',
      qualification: 'missing',
      reason: 'No exact live qualification record',
    },
    recovery: {
      truncatedEventBytes: 0,
      truncatedEffectBytes: 0,
      pendingEffects: 0,
      uncertainEffects: 0,
      abandonedEffects: 0,
    },
    ...overrides,
  };
}

function renderView(props: Partial<Parameters<typeof CodeProControlPlaneView>[0]> = {}) {
  const callbacks = {
    projection: projection(),
    pending: false,
    onAction: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onResolve: vi.fn().mockResolvedValue(undefined),
    ...props,
  };
  return {
    ...callbacks,
    ...render(<CodeProControlPlaneView {...callbacks} />, { wrapper: IntlTestWrapper }),
  };
}

describe('CodeProControlPlaneView', () => {
  it('shows user-facing live progress and keeps coordinator internals collapsed', () => {
    const view = renderView();
    expect(screen.getByText('Running tasks')).toBeVisible();
    expect(screen.getByText('0 of 1 steps completed')).toBeVisible();
    expect(screen.getByText('Current step: Fix login')).toBeVisible();
    expect(screen.getByText(/authoritative → shadow/)).not.toBeVisible();

    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getByText(/authoritative → shadow/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop agent-1' }));
    expect(view.onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stop_worker', agentId: 'agent-1' }),
      'Stop agent-1'
    );
  });

  it('offers explicit resolution only for uncertain effects', () => {
    const view = renderView({
      projection: projection({
        effects: [
          {
            effectId: 'run-1::effect:4:0',
            triggerEventId: 'event:4',
            state: 'uncertain',
            summary: 'Remote dispatch outcome is unknown',
            requiresResolution: true,
          },
        ],
      }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Waiting for review');
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(view.onResolve).toHaveBeenCalledWith('run-1::effect:4:0', 'confirmed_applied');
  });

  it('disables controls while awaiting a backend receipt and exposes failures', () => {
    renderView({ pending: true, error: 'stale sequence' });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('stale sequence');
  });

  it('shows verification recovery states without calling them limitations', () => {
    renderView({
      projection: projection({
        tasks: [
          {
            taskId: 'verify',
            name: 'node tests.js',
            state: 'verification_failed',
            retryAttempts: 1,
            evidence: [],
          },
          {
            taskId: 'exhausted',
            name: 'Repeated validation',
            state: 'repair_exhausted',
            retryAttempts: 2,
            evidence: [],
          },
        ],
      }),
    });

    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getByText(/node tests\.js · Verification failed; repair pending/)).toBeVisible();
    expect(screen.getByText(/Repeated validation · Repair budget exhausted/)).toBeVisible();
    expect(screen.queryByText(/limitation/i)).not.toBeInTheDocument();
  });

  it.each([
    ['verification_failed', 'A check did not pass; preparing a repair'],
    ['repairing', 'Coder is repairing the implementation'],
    ['retesting', 'Tester is rerunning the same command'],
    ['waiting_for_environment', 'Waiting for the environment; progress is saved'],
  ] as const)('renders %s from the structured run state', (state, message) => {
    renderView({ projection: projection({ state }) });
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByText(/limitation/i)).not.toBeInTheDocument();
  });
});
