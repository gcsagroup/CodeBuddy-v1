import type { CodeProEffectResolution, CodeProRunControlAction } from '@aaif/goose-sdk';
import { AlertTriangle } from 'lucide-react';
import type { CodeProRunProjection } from '../../codepro/runProjection';
import { useIntl } from '../../i18n';
import '../ui/disclosure.css';

interface DetailsProps {
  controlClass: string;
  onAction: (action: CodeProRunControlAction, label: string) => Promise<void>;
  onResolve: (effectId: string, resolution: CodeProEffectResolution) => Promise<void>;
  pending: boolean;
  projection: CodeProRunProjection;
}

export function CodeProControlPlaneDetails({
  controlClass,
  onAction,
  onResolve,
  pending,
  projection,
}: DetailsProps) {
  const intl = useIntl();
  const stopLabel = intl.formatMessage({ id: 'chatInput.stop', defaultMessage: 'Stop' });
  const cancelLabel = intl.formatMessage({ id: 'sessions.cancel', defaultMessage: 'Cancel' });
  const branchLabel = intl.formatMessage({
    id: 'toolConfirmation.branch',
    defaultMessage: 'Branch',
  });
  const completedLabel = intl.formatMessage({
    id: 'codeProPresentation.summaryStatus.completed',
    defaultMessage: 'Completed',
  });
  const uncertain = projection.effects.filter((effect) => effect.requiresResolution);
  const terminalTaskStates = ['succeeded', 'repair_exhausted', 'failed', 'cancelled', 'skipped'];
  const runAction = (action: CodeProRunControlAction, label: string) => () =>
    void onAction(action, label);

  return (
    <>
      <details className="codepro-disclosure mt-2 text-xs text-text-secondary">
        <summary className="cursor-pointer rounded font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary">
          {intl.formatMessage({
            id: 'codeProControlPlane.technicalDetails',
            defaultMessage: 'Technical details',
          })}
        </summary>
        <div className="mt-1.5 rounded border border-border-primary bg-background-primary px-2 py-1.5">
          <p className="text-text-primary">
            {projection.coordinator.requestedMode} → {projection.coordinator.effectiveMode}
          </p>
          <p className="mt-0.5 break-words text-text-secondary">
            {projection.coordinator.qualification} · {projection.coordinator.reason}
          </p>
          <p className="mt-0.5 text-text-secondary">
            {intl.formatMessage(
              {
                id: 'codeProControlPlane.eventSequence',
                defaultMessage: 'Event #{sequence}',
              },
              { sequence: projection.lastSequence }
            )}
          </p>
        </div>
        <ul
          className="mt-1.5 space-y-1"
          aria-label={intl.formatMessage({
            id: 'codeProTaskPanel.tasks',
            defaultMessage: 'Tasks',
          })}
        >
          {projection.agents.map((agent) => (
            <li key={agent.agentId} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {agent.role} · {agent.agentId} · {agent.state}
              </span>
              {['starting', 'running', 'idle'].includes(agent.state) && (
                <button
                  type="button"
                  className={controlClass}
                  disabled={pending}
                  aria-label={`${stopLabel} ${agent.agentId}`}
                  onClick={runAction(
                    {
                      type: 'stop_worker',
                      agentId: agent.agentId,
                      reason: 'Requested from desktop control surface',
                    },
                    `${stopLabel} ${agent.agentId}`
                  )}
                >
                  {stopLabel}
                </button>
              )}
            </li>
          ))}
          {projection.tasks.map((task) => (
            <li key={task.taskId} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {task.name} · {taskStateLabel(task.state)}
                {task.inCurrentPlan === false &&
                  ` · ${intl.formatMessage({ id: 'sessions.chatHistory', defaultMessage: 'History' })}`}
              </span>
              {task.inCurrentPlan !== false && !terminalTaskStates.includes(task.state) && (
                <span className="flex gap-1">
                  <button
                    type="button"
                    className={controlClass}
                    disabled={pending}
                    aria-label={`${cancelLabel} ${task.name}`}
                    onClick={runAction(
                      {
                        type: 'cancel_task',
                        taskId: task.taskId,
                        reason: 'Requested from desktop control surface',
                      },
                      `${cancelLabel} ${task.name}`
                    )}
                  >
                    {cancelLabel}
                  </button>
                  <button
                    type="button"
                    className={controlClass}
                    disabled={pending}
                    aria-label={`${cancelLabel} ${branchLabel} ${task.name}`}
                    onClick={runAction(
                      {
                        type: 'cancel_branch',
                        rootTaskId: task.taskId,
                        reason: 'Requested from desktop control surface',
                      },
                      `${cancelLabel} ${branchLabel} ${task.name}`
                    )}
                  >
                    {branchLabel}
                  </button>
                </span>
              )}
            </li>
          ))}
          {projection.recentEvents.slice(-8).map((event) => (
            <li key={event.eventId}>
              #{event.sequence} · {event.eventType}
              {event.evidence?.map((item) => ` · ${item.artifactRef}`).join('')}
            </li>
          ))}
        </ul>
      </details>
      {uncertain.length > 0 && (
        <div
          className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
          role="alert"
        >
          <p className="flex items-center gap-1.5 font-medium text-text-primary">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage({
              id: 'toolAudit.outcome.ambiguous',
              defaultMessage: 'Waiting for review',
            })}
          </p>
          {uncertain.map((effect) => (
            <div key={effect.effectId} className="mt-1.5">
              <p className="break-words text-text-secondary">{effect.summary}</p>
              <div className="mt-1 flex gap-1.5">
                <button
                  type="button"
                  className={controlClass}
                  disabled={pending}
                  onClick={() => void onResolve(effect.effectId, 'confirmed_applied')}
                >
                  {completedLabel}
                </button>
                <button
                  type="button"
                  className={controlClass}
                  disabled={pending}
                  onClick={() => void onResolve(effect.effectId, 'confirmed_not_applied')}
                >
                  {intl.formatMessage({ id: 'appsView.retry', defaultMessage: 'Retry' })}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function taskStateLabel(state: CodeProRunProjection['tasks'][number]['state']): string {
  switch (state) {
    case 'verification_failed':
      return 'Verification failed; repair pending';
    case 'repair_pending':
      return 'Repair pending';
    case 'waiting_for_user':
      return 'Waiting for user';
    case 'repair_exhausted':
      return 'Repair budget exhausted';
    default:
      return state.replace(/_/g, ' ');
  }
}
