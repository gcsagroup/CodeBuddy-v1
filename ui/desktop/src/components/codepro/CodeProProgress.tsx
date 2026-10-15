import { useEffect, useMemo, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Ban, Check, ChevronDown, ChevronRight, CircleDashed, LoaderCircle, X } from 'lucide-react';
import { ChatState } from '../../types/chatState';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { parseCodeProTasks, type TaskCardData, type TaskCardStatus } from './CodeProTaskPanel';
import { formatCodeProTaskStatus } from './codeProPresentation';

interface CodeProProgressProps {
  chatState: ChatState;
  message?: string;
}

export function isCodeProProgressPath(pathname: string): boolean {
  return pathname === '/codepro' || pathname.startsWith('/codepro/');
}

export function shouldShowFloatingProgress(pathname: string): boolean {
  return pathname === '/pair' || pathname === '/codepro/pair';
}

const i18n = defineMessages({
  workProcess: { id: 'codeProProgress.workProcess', defaultMessage: 'Work process' },
  workProcessRegion: {
    id: 'codeProProgress.workProcessRegion',
    defaultMessage: 'CodePro work process',
  },
  collapse: { id: 'codeProProgress.collapse', defaultMessage: 'Collapse work process' },
  expand: { id: 'codeProProgress.expand', defaultMessage: 'Expand work process' },
  completionProgress: {
    id: 'codeProProgress.completionProgress',
    defaultMessage: 'Task completion progress',
  },
  completed: {
    id: 'codeProProgress.completed',
    defaultMessage: '{completed} / {total} completed',
  },
  fallbackPhase: {
    id: 'codeProProgress.fallbackPhase',
    defaultMessage: 'Processing tasks',
  },
  waiting: {
    id: 'codeProProgress.waiting',
    defaultMessage: 'Waiting for your confirmation…',
  },
  understanding: {
    id: 'codeProProgress.understanding',
    defaultMessage: 'Understanding the project and splitting tasks…',
  },
  elapsed: {
    id: 'codeProProgress.elapsed',
    defaultMessage: 'Elapsed {time}',
  },
});

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function phaseFromMessage(message: string | undefined, fallback: string): string {
  const firstLine = message?.split(/\r?\n/, 1)[0]?.trim();
  return firstLine?.replace(/^CodePro\s*·\s*/, '') || fallback;
}

const taskSnapshotMarker = '--- CodePro 任务快照 ---';
const publicProgressLine =
  /^(?:当前阶段|当前任务|说明|下一步|最近结果|进度|验收目标|流程|原因)[:：]/;

function publicProgressDetails(message: string | undefined): string[] {
  if (!message?.trim()) return [];
  const [publicSummary] = message.split(taskSnapshotMarker, 1);
  return publicSummary
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => publicProgressLine.test(line))
    .slice(0, 4);
}

function TaskStatusIcon({ status }: { status: TaskCardStatus }) {
  const iconClass = 'h-3.5 w-3.5 shrink-0';
  if (status === 'passed') return <Check className={cn(iconClass, 'text-green-600')} />;
  if (status === 'failed') return <X className={cn(iconClass, 'text-red-600')} />;
  if (status === 'skipped')
    return <ChevronRight className={cn(iconClass, 'text-text-secondary')} />;
  if (status === 'paused') return <Ban className={cn(iconClass, 'text-amber-600')} />;
  if (status === 'cancelled') return <Ban className={cn(iconClass, 'text-amber-600')} />;
  if (status === 'running') {
    return <LoaderCircle className={cn(iconClass, 'animate-spin text-text-secondary')} />;
  }
  return <CircleDashed className={cn(iconClass, 'text-text-secondary')} />;
}

function TaskRow({ task }: { task: TaskCardData }) {
  const intl = useIntl();
  return (
    <li className="flex min-w-0 items-center gap-2.5 border-t border-border-primary px-3 py-2 first:border-t-0">
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded border',
          task.status === 'passed'
            ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
            : task.status === 'failed'
              ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
              : task.status === 'paused'
                ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
                : task.status === 'cancelled'
                  ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
                  : 'border-border-primary bg-background-secondary'
        )}
        aria-hidden="true"
      >
        <TaskStatusIcon status={task.status} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary">{task.name}</p>
      </div>
      <span
        className={cn(
          'shrink-0 text-xs',
          task.status === 'passed'
            ? 'text-green-700 dark:text-green-400'
            : task.status === 'failed'
              ? 'text-red-700 dark:text-red-400'
              : task.status === 'paused'
                ? 'text-amber-700 dark:text-amber-400'
                : task.status === 'cancelled'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-text-secondary'
        )}
      >
        {formatCodeProTaskStatus(intl, task.status)}
      </span>
    </li>
  );
}

export function CodeProProgress({ chatState, message }: CodeProProgressProps) {
  const intl = useIntl();
  const fallbackPhase = intl.formatMessage(i18n.fallbackPhase);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const [expanded, setExpanded] = useState(true);
  const parsedTasks = useMemo(() => parseCodeProTasks(message ?? ''), [message]);
  const progressDetails = useMemo(() => publicProgressDetails(message), [message]);
  const [cachedTasks, setCachedTasks] = useState<TaskCardData[]>(parsedTasks);
  const [cachedPhase, setCachedPhase] = useState(() => phaseFromMessage(message, fallbackPhase));
  const isWaiting = chatState === ChatState.WaitingForUserInput;
  useEffect(() => {
    if (parsedTasks.length > 0) setCachedTasks(parsedTasks);
    if (message?.trim()) setCachedPhase(phaseFromMessage(message, fallbackPhase));
  }, [fallbackPhase, message, parsedTasks]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (isWaiting) setExpanded(false);
  }, [isWaiting]);
  const tasks = parsedTasks.length > 0 ? parsedTasks : cachedTasks;
  const completed = tasks.filter((task) => task.status === 'passed').length;
  const phase = message?.trim() ? phaseFromMessage(message, fallbackPhase) : cachedPhase;
  const progress = tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 100);
  const elapsed = formatElapsedTime(Math.max(0, Math.floor((now - startedAt) / 1_000)));

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <section
        className="pointer-events-auto w-full max-w-3xl overflow-hidden rounded-lg border border-border-primary bg-background-primary shadow-sm"
        aria-label={intl.formatMessage(i18n.workProcessRegion)}
        aria-live="polite"
      >
        <CollapsibleTrigger
          type="button"
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          aria-expanded={expanded}
          aria-label={intl.formatMessage(expanded ? i18n.collapse : i18n.expand)}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-primary bg-background-secondary">
            {isWaiting ? (
              <CircleDashed className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
            ) : (
              <LoaderCircle
                className="h-3.5 w-3.5 animate-spin text-text-secondary"
                aria-hidden="true"
              />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-text-primary">
                {intl.formatMessage(i18n.workProcess)}
              </span>
              <span className="truncate text-xs text-text-secondary">{phase}</span>
            </div>
            {tasks.length > 0 && (
              <div
                className="mt-1 h-0.5 overflow-hidden rounded bg-background-secondary"
                role="progressbar"
                aria-label={intl.formatMessage(i18n.completionProgress)}
                aria-valuemin={0}
                aria-valuemax={tasks.length}
                aria-valuenow={completed}
              >
                <div
                  className="h-full bg-text-primary transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
          {tasks.length > 0 && (
            <span className="shrink-0 text-xs tabular-nums text-text-secondary">
              {intl.formatMessage(i18n.completed, { completed, total: tasks.length })}
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-text-secondary">
            {intl.formatMessage(i18n.elapsed, { time: elapsed })}
          </span>
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
        </CollapsibleTrigger>

        <CollapsibleContent className="codepro-disclosure-content">
          <div className="border-t border-border-primary">
            {progressDetails.length > 0 ? (
              <ul className="space-y-1 px-3 py-2.5 text-xs text-text-secondary">
                {progressDetails.map((detail) => (
                  <li key={detail} className="break-words">
                    {detail}
                  </li>
                ))}
              </ul>
            ) : tasks.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-text-secondary">
                {intl.formatMessage(isWaiting ? i18n.waiting : i18n.understanding)}
              </p>
            ) : null}
            {tasks.length > 0 && (
              <ol
                className={cn(
                  'max-h-56 overflow-y-auto',
                  progressDetails.length > 0 && 'border-t border-border-primary'
                )}
              >
                {tasks.map((task) => (
                  <TaskRow key={`${task.id}-${task.name}`} task={task} />
                ))}
              </ol>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
