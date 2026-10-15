import type { CodeProEffectResolution, CodeProRunControlAction } from '@aaif/goose-sdk';
import { Pause, Play, RefreshCw, Square } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { codeProRunCommands } from '../../codepro/runCommands';
import type { CodeProRunProjection } from '../../codepro/runProjection';
import { useCodeProRunProjection } from '../../codepro/useCodeProRunProjection';
import { defineMessages, useIntl } from '../../i18n';
import { cn } from '../../utils';
import { CodeProControlPlaneDetails } from './CodeProControlPlaneDetails';

interface CodeProControlPlanePanelProps {
  runId?: string | null;
  sessionId: string;
}

const i18n = defineMessages({
  currentProgress: {
    id: 'codeProControlPlane.currentProgress',
    defaultMessage: 'Current progress',
  },
  notStarted: { id: 'codeProControlPlane.notStarted', defaultMessage: 'Preparing to start' },
  planning: {
    id: 'codeProControlPlane.planning',
    defaultMessage: 'Understanding the request and planning',
  },
  running: { id: 'codeProControlPlane.running', defaultMessage: 'Running tasks' },
  verificationFailed: {
    id: 'codeProControlPlane.verificationFailed',
    defaultMessage: 'A check did not pass; preparing a repair',
  },
  repairing: {
    id: 'codeProControlPlane.repairing',
    defaultMessage: 'Coder is repairing the implementation',
  },
  retesting: {
    id: 'codeProControlPlane.retesting',
    defaultMessage: 'Tester is rerunning the same command',
  },
  waitingForUser: {
    id: 'codeProControlPlane.waitingForUser',
    defaultMessage: 'Waiting for your confirmation',
  },
  waitingForEnvironment: {
    id: 'codeProControlPlane.waitingForEnvironment',
    defaultMessage: 'Waiting for the environment; progress is saved',
  },
  paused: { id: 'codeProControlPlane.paused', defaultMessage: 'Paused' },
  recovering: {
    id: 'codeProControlPlane.recovering',
    defaultMessage: 'Resuming saved work',
  },
  completing: {
    id: 'codeProControlPlane.completing',
    defaultMessage: 'Preparing the result',
  },
  completed: { id: 'codeProControlPlane.completed', defaultMessage: 'Completed' },
  exhausted: {
    id: 'codeProControlPlane.exhausted',
    defaultMessage: 'The available execution budget was used',
  },
  fatal: {
    id: 'codeProControlPlane.fatal',
    defaultMessage: 'The task could not be recovered safely',
  },
  failed: {
    id: 'codeProControlPlane.failed',
    defaultMessage: 'Could not complete the task',
  },
  cancelled: { id: 'codeProControlPlane.cancelled', defaultMessage: 'Stopped' },
  completedSteps: {
    id: 'codeProControlPlane.completedSteps',
    defaultMessage: '{completed} of {total} steps completed',
  },
  currentStep: {
    id: 'codeProControlPlane.currentStep',
    defaultMessage: 'Current step: {name}',
  },
});

function runStateMessage(state: CodeProRunProjection['state']) {
  switch (state) {
    case 'not_started':
      return i18n.notStarted;
    case 'planning':
      return i18n.planning;
    case 'running':
      return i18n.running;
    case 'verification_failed':
      return i18n.verificationFailed;
    case 'repairing':
      return i18n.repairing;
    case 'retesting':
      return i18n.retesting;
    case 'waiting_for_user':
      return i18n.waitingForUser;
    case 'waiting_for_environment':
      return i18n.waitingForEnvironment;
    case 'paused':
      return i18n.paused;
    case 'recovering':
      return i18n.recovering;
    case 'completing':
      return i18n.completing;
    case 'completed':
      return i18n.completed;
    case 'exhausted':
      return i18n.exhausted;
    case 'fatal':
      return i18n.fatal;
    case 'failed':
      return i18n.failed;
    case 'cancelled':
      return i18n.cancelled;
  }
}

export interface CodeProControlPlaneViewProps {
  error?: string;
  onAction: (action: CodeProRunControlAction, label: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onResolve: (effectId: string, resolution: CodeProEffectResolution) => Promise<void>;
  pending: boolean;
  projection: CodeProRunProjection;
}

export function CodeProControlPlanePanel({ sessionId, runId }: CodeProControlPlanePanelProps) {
  const { projection, refresh } = useCodeProRunProjection(sessionId, runId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (!projection || !runId) return null;

  const perform = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
    } finally {
      setPending(false);
    }
  };

  return (
    <CodeProControlPlaneView
      projection={projection}
      pending={pending}
      error={error}
      onRefresh={() => perform(refresh)}
      onAction={(action, label) => {
        if (!window.confirm(`${label}?`)) return Promise.resolve();
        return perform(() => codeProRunCommands.control(sessionId, runId, action));
      }}
      onResolve={(effectId, resolution) =>
        perform(() => codeProRunCommands.resolveEffect(sessionId, runId, effectId, resolution))
      }
    />
  );
}

export function CodeProControlPlaneView({
  error,
  onAction,
  onRefresh,
  onResolve,
  pending,
  projection,
}: CodeProControlPlaneViewProps) {
  const intl = useIntl();
  const statusLabel = intl.formatMessage(i18n.currentProgress);
  const canPause = [
    'planning',
    'running',
    'verification_failed',
    'repairing',
    'retesting',
    'waiting_for_user',
    'waiting_for_environment',
    'recovering',
  ].includes(projection.state);
  const canResume = projection.state === 'paused';
  const canStop = !['completed', 'exhausted', 'fatal', 'failed', 'cancelled'].includes(
    projection.state
  );
  const runAction = (action: CodeProRunControlAction, label: string) => () =>
    void onAction(action, label);
  const controlClass =
    'inline-flex min-h-8 items-center gap-1.5 rounded border border-border-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary disabled:cursor-not-allowed disabled:opacity-50';
  const currentTasks = projection.tasks.filter((task) => task.inCurrentPlan !== false);
  const completedTasks = currentTasks.filter((task) => task.state === 'succeeded').length;
  const activeTask = currentTasks.find((task) =>
    [
      'running',
      'verification_failed',
      'repair_pending',
      'waiting_for_user',
      'waiting_for_coordinator',
      'waiting_for_approval',
      'paused',
      'ready',
      'proposed',
    ].includes(task.state)
  );

  return (
    <section
      className="border-b border-border-primary bg-background-secondary/40 px-3 py-2.5"
      aria-label={`CodePro ${statusLabel}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-text-primary">{statusLabel}</h3>
          <p className="mt-0.5 text-xs font-medium text-text-primary">
            {intl.formatMessage(runStateMessage(projection.state))}
          </p>
          {currentTasks.length > 0 && (
            <p className="mt-0.5 text-xs text-text-secondary">
              {intl.formatMessage(i18n.completedSteps, {
                completed: completedTasks,
                total: currentTasks.length,
              })}
            </p>
          )}
          {activeTask && (
            <p className="mt-0.5 break-words text-xs text-text-secondary">
              {intl.formatMessage(i18n.currentStep, { name: activeTask.name })}
            </p>
          )}
        </div>
        <button
          type="button"
          className={controlClass}
          disabled={pending}
          onClick={() => void onRefresh()}
          aria-label={intl.formatMessage({
            id: 'schedulesView.refresh',
            defaultMessage: 'Refresh',
          })}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', pending && 'animate-spin')} aria-hidden="true" />
          {intl.formatMessage({ id: 'schedulesView.refresh', defaultMessage: 'Refresh' })}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {canPause && (
          <ControlButton
            label={intl.formatMessage({ id: 'schedulesView.pause', defaultMessage: 'Pause' })}
            icon={<Pause className="h-3.5 w-3.5" aria-hidden="true" />}
            disabled={pending}
            className={controlClass}
            onClick={runAction(
              { type: 'pause_run', reason: 'Requested from desktop control surface' },
              intl.formatMessage({ id: 'schedulesView.pause', defaultMessage: 'Pause' })
            )}
          />
        )}
        {canResume && (
          <ControlButton
            label={intl.formatMessage({ id: 'schedulesView.resume', defaultMessage: 'Resume' })}
            icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
            disabled={pending}
            className={controlClass}
            onClick={runAction(
              { type: 'resume_run' },
              intl.formatMessage({ id: 'schedulesView.resume', defaultMessage: 'Resume' })
            )}
          />
        )}
        {canStop && (
          <ControlButton
            label={intl.formatMessage({ id: 'chatInput.stop', defaultMessage: 'Stop' })}
            icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
            disabled={pending}
            className={cn(controlClass, 'text-red-700')}
            onClick={runAction(
              { type: 'emergency_stop', reason: 'Requested from desktop control surface' },
              intl.formatMessage({ id: 'chatInput.stop', defaultMessage: 'Stop' })
            )}
          />
        )}
      </div>

      <CodeProControlPlaneDetails
        controlClass={controlClass}
        onAction={onAction}
        onResolve={onResolve}
        pending={pending}
        projection={projection}
      />
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ControlButton({
  className,
  disabled,
  icon,
  label,
  onClick,
}: {
  className: string;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={className} disabled={disabled} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
