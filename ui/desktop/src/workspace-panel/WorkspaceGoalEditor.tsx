import { useRef, useState } from 'react';
import { RotateCcw, Save, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { changeSessionGoal, getSessionGoal, type LongTermGoal } from '../acp/goals';
import { notifyGoalChanged } from './goalPanel';

export const goalEditorMessages = defineMessages({
  title: { id: 'goalEditor.title', defaultMessage: 'Edit goal' },
  saved: { id: 'goalEditor.saved', defaultMessage: 'Saved' },
  unsaved: { id: 'goalEditor.unsaved', defaultMessage: 'Unsaved changes' },
  undo: { id: 'goalEditor.undo', defaultMessage: 'Undo changes' },
  save: { id: 'goalEditor.save', defaultMessage: 'Save' },
  saving: { id: 'goalEditor.saving', defaultMessage: 'Saving…' },
  refresh: { id: 'goalEditor.refresh', defaultMessage: 'Read latest goal' },
  failure: {
    id: 'goalEditor.failure',
    defaultMessage:
      'The goal could not be saved. Your draft is kept. Read the latest goal before retrying.',
  },
  missing: { id: 'goalEditor.missing', defaultMessage: 'This conversation no longer has a goal.' },
  hint: {
    id: 'goalEditor.hint',
    defaultMessage:
      'Describe the outcome and acceptance criteria. Saving updates the goal without starting or resuming execution.',
  },
});

export function WorkspaceGoalEditor({
  sessionId,
  goal,
  draft,
  onDraftChange,
  onGoalChange,
}: {
  sessionId: string;
  goal: LongTermGoal;
  draft: string;
  onDraftChange: (value: string) => void;
  onGoalChange: (value: LongTermGoal, submittedDraft?: string) => void;
}) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'failure' | 'missing'>();
  const inFlight = useRef(false);
  const dirty = draft !== goal.objective;
  const label = (key: keyof typeof goalEditorMessages) =>
    intl.formatMessage(goalEditorMessages[key]);
  const save = async () => {
    if (inFlight.current || !dirty || !draft.trim() || draft.trim().length > 16000) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await changeSessionGoal(sessionId, goal, 'edit', draft.trim());
      if (!updated) {
        setError('missing');
        return;
      }
      onGoalChange(updated, draft);
      notifyGoalChanged(sessionId);
    } catch {
      setError('failure');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const updated = await getSessionGoal(sessionId);
      if (!updated) {
        setError('missing');
        return;
      }
      onGoalChange(updated);
      setError(undefined);
    } catch {
      setError('failure');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background-primary"
      aria-label={label('title')}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border-primary px-4 py-3">
        <span className="text-xs text-text-secondary" role="status">
          {label(busy ? 'saving' : dirty ? 'unsaved' : 'saved')}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded-md p-1.5 text-text-secondary hover:bg-background-secondary disabled:opacity-40"
            title={label('undo')}
            aria-label={label('undo')}
            disabled={busy || !dirty}
            onClick={() => onDraftChange(goal.objective)}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-text-primary px-3 py-1.5 text-xs text-background-primary disabled:opacity-40"
            disabled={
              busy || !dirty || !draft.trim() || draft.trim().length > 16000 || error === 'missing'
            }
            onClick={() => void save()}
          >
            <Save size={13} />
            {label('save')}
          </button>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="mx-4 mt-3 rounded-lg bg-background-secondary p-3 text-xs leading-5 text-text-secondary"
        >
          {label(error)}
          <button
            type="button"
            className="mt-2 flex items-center gap-1 underline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} />
            {label('refresh')}
          </button>
        </div>
      )}
      <textarea
        aria-label={label('title')}
        className="min-h-40 min-w-0 flex-1 resize-none bg-transparent p-5 text-sm leading-7 text-text-primary outline-none"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        spellCheck={false}
      />
      <p className="shrink-0 px-5 pb-4 text-xs leading-5 text-text-secondary">{label('hint')}</p>
    </section>
  );
}
