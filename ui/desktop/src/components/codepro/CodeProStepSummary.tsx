import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Ban, Check, ChevronDown, Circle, LoaderCircle, X } from 'lucide-react';
import { useAcpChatSessionSnapshot } from '../../acp/chatSessionStore';
import { ChatState } from '../../types/chatState';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { type TaskCardData, useRetainedCodeProTasks } from './CodeProTaskPanel';

export { useRetainedCodeProTasks } from './CodeProTaskPanel';

interface CodeProStepSummaryViewProps {
  fileCount: number;
  isRunning: boolean;
  tasks: TaskCardData[];
  compacting?: boolean;
}

const i18n = defineMessages({
  executionSteps: {
    id: 'codeProStepSummary.executionSteps',
    defaultMessage: 'CodePro execution steps',
  },
  steps: { id: 'codeProStepSummary.steps', defaultMessage: '{completed} / {total} steps' },
  stopped: { id: 'codeProStepSummary.stopped', defaultMessage: 'Stopped' },
  taskCompleted: { id: 'codeProStepSummary.taskCompleted', defaultMessage: 'Task completed' },
  changedFiles: {
    id: 'codeProStepSummary.changedFiles',
    defaultMessage: '{count, plural, one {# file changed} other {# files changed}}',
  },
  accessibleSummary: {
    id: 'codeProStepSummary.accessibleSummary',
    defaultMessage: '{steps}, {task}, {files}',
  },
});

export function CodeProStepSummaryView({
  fileCount,
  isRunning,
  tasks,
  compacting,
}: CodeProStepSummaryViewProps) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const completedCount = tasks.filter((task) => task.status === 'passed').length;
  const currentTask =
    tasks.find((task) => task.status === 'running') ??
    tasks.find((task) => task.status === 'queued') ??
    tasks[tasks.length - 1];
  const summary = intl.formatMessage(i18n.steps, {
    completed: completedCount,
    total: tasks.length,
  });
  const currentTaskName = currentTask?.name ?? intl.formatMessage(i18n.taskCompleted);
  const changedFiles = intl.formatMessage(i18n.changedFiles, { count: fileCount });
  const hasIncompleteTasks = tasks.some(
    (task) => task.status === 'running' || task.status === 'queued'
  );
  const isStopped = !isRunning && hasIncompleteTasks;

  if (tasks.length === 0) return null;
  if (!isRunning && !isStopped) return null;

  const stoppedLabel = intl.formatMessage(i18n.stopped);
  const displayTaskName = isStopped
    ? stoppedLabel
    : compacting
      ? `正在整理对话上下文 · ${currentTaskName}`
      : currentTaskName;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="relative z-30 mx-auto mb-2 w-fit max-w-[min(720px,calc(100%-2rem))]"
    >
      {!isStopped && (
        <CollapsibleContent className="codepro-disclosure-content absolute bottom-full left-1/2 mb-2 w-[min(480px,calc(100vw-3rem))] -translate-x-1/2">
          <div className="rounded-lg border border-border-primary bg-background-primary p-2 shadow-lg">
            <ol aria-label={intl.formatMessage(i18n.executionSteps)} className="space-y-0.5">
              {tasks.map((task) => {
                const Icon =
                  task.status === 'passed'
                    ? Check
                    : task.status === 'failed'
                      ? X
                      : task.status === 'skipped'
                        ? Circle
                        : task.status === 'paused'
                          ? Ban
                          : task.status === 'cancelled'
                            ? Ban
                            : task.status === 'running'
                              ? LoaderCircle
                              : Circle;
                return (
                  <li
                    key={task.id}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-text-primary"
                  >
                    <Icon
                      className={cn(
                        'mt-0.5 h-4 w-4 shrink-0',
                        task.status === 'passed' && 'text-green-600',
                        task.status === 'failed' && 'text-red-600',
                        task.status === 'skipped' && 'text-text-secondary',
                        task.status === 'paused' && 'text-amber-600',
                        task.status === 'cancelled' && 'text-amber-600',
                        task.status === 'running' && 'animate-spin text-text-secondary'
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">{task.name}</span>
                    <span className="shrink-0 font-mono text-xs text-text-secondary">
                      {task.id}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </CollapsibleContent>
      )}

      <CollapsibleTrigger
        type="button"
        className="flex max-w-full items-center gap-2 rounded-full border border-border-primary bg-background-primary px-4 py-2 text-sm text-text-secondary shadow-sm transition-colors hover:bg-background-secondary hover:text-text-primary"
        aria-expanded={expanded}
        aria-label={intl.formatMessage(i18n.accessibleSummary, {
          steps: summary,
          task: displayTaskName,
          files: changedFiles,
        })}
      >
        {isStopped ? (
          <Ban className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        ) : (
          <LoaderCircle
            className="h-4 w-4 shrink-0 animate-spin text-blue-500"
            aria-hidden="true"
          />
        )}
        <span className="shrink-0">{summary}</span>
        <span aria-hidden="true">·</span>
        <span className={cn('truncate text-text-primary', isStopped && 'text-amber-600')}>
          {displayTaskName}
        </span>
        {fileCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{changedFiles}</span>
          </>
        )}
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
    </Collapsible>
  );
}

export function CodeProStepSummary({ sessionId }: { sessionId: string }) {
  const snapshot = useAcpChatSessionSnapshot(sessionId);
  const isRunning = snapshot?.chatState !== undefined && snapshot.chatState !== ChatState.Idle;
  const tasks = useRetainedCodeProTasks({
    isRunning,
    progressMessage: snapshot?.progressMessage,
    sessionId,
  });
  const fileCount = new Set(tasks.flatMap((task) => task.filesChanged ?? [])).size;

  return (
    <CodeProStepSummaryView
      fileCount={fileCount}
      isRunning={isRunning}
      tasks={tasks}
      compacting={snapshot?.chatState === ChatState.Compacting}
    />
  );
}
