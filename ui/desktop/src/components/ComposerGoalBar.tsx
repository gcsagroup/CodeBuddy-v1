import { useEffect, useState } from 'react';
import { Pause, Pencil, Play, Target, Trash2 } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { getSessionGoal, type LongTermGoal } from '../acp/goals';

const messages = defineMessages({
  active: { id: 'composerGoalBar.active', defaultMessage: 'Active goal' },
  paused: { id: 'composerGoalBar.paused', defaultMessage: 'Paused goal' },
  idle: { id: 'composerGoalBar.idle', defaultMessage: 'Goal ready to resume' },
  blocked: { id: 'composerGoalBar.blocked', defaultMessage: 'Goal needs attention' },
  pause: { id: 'composerGoalBar.pause', defaultMessage: 'Pause goal' },
  resume: { id: 'composerGoalBar.resume', defaultMessage: 'Resume goal' },
  edit: { id: 'composerGoalBar.edit', defaultMessage: 'Edit goal' },
  clear: { id: 'composerGoalBar.clear', defaultMessage: 'Clear goal; keep conversation and files' },
  details: { id: 'composerGoalBar.details', defaultMessage: 'View goal details' },
  unavailable: {
    id: 'composerGoalBar.unavailable',
    defaultMessage: 'Goal state is unavailable. Use /goal status to retry.',
  },
});

export function ComposerGoalBar({
  sessionId,
  busy,
  refreshKey,
  onCommand,
  onEdit,
}: {
  sessionId: string | null;
  busy: boolean;
  refreshKey: number;
  onCommand: (command: string) => Promise<void>;
  onEdit: (objective: string) => void;
}) {
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<{ sessionId: string; goal: LongTermGoal | null }>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false,
      inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const goal = await getSessionGoal(sessionId);
        if (!disposed) {
          setSnapshot({ sessionId, goal });
          setUnavailable(false);
        }
      } catch {
        if (!disposed) setUnavailable(true);
      } finally {
        inFlight = false;
      }
    };
    void read();
    const timer = busy ? setInterval(() => void read(), 2000) : undefined;
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sessionId, busy, refreshKey]);
  const goal = snapshot?.sessionId === sessionId ? snapshot.goal : null;
  if (!goal || goal.phase === 'complete') return null;
  const running = goal.phase === 'active' && goal.activation === 'armed';
  const state = running ? 'active' : goal.phase === 'active' ? 'idle' : goal.phase;
  const actionClass =
    'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-background-tertiary disabled:opacity-40';
  const label = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  return (
    <div
      data-goal-bar
      className="mx-2 mt-2 flex min-h-9 min-w-0 items-center gap-2 rounded-lg bg-background-secondary px-2 text-xs text-text-primary"
    >
      <Target className="size-3.5 shrink-0 text-text-secondary" />
      <span className="shrink-0">{label(state)}</span>
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left"
        title={goal.objective}
        aria-label={label('details')}
        onClick={() => onEdit(goal.objective)}
      >
        {unavailable ? label('unavailable') : goal.objective}
      </button>
      <button
        type="button"
        className={actionClass}
        title={label(running ? 'pause' : 'resume')}
        aria-label={label(running ? 'pause' : 'resume')}
        disabled={unavailable || (!running && (busy || goal.roundsStarted >= goal.maxGoalRounds))}
        onClick={() => void onCommand(running ? '/goal pause' : '/goal resume')}
      >
        {running ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        type="button"
        className={actionClass}
        title={label('edit')}
        aria-label={label('edit')}
        disabled={unavailable}
        onClick={() => onEdit(goal.objective)}
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        className={actionClass}
        title={label('clear')}
        aria-label={label('clear')}
        disabled={unavailable}
        onClick={() => void onCommand('/goal clear')}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
