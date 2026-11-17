import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Files,
  GitBranch,
  GitPullRequest,
  ListTodo,
  RotateCcw,
  Workflow,
  X,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAcpChatSessionSnapshot } from '../../acp/chatSessionStore';
import { ChatState } from '../../types/chatState';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { CodeProFileViewer } from './CodeProFileViewer';
import { CodeProControlPlanePanel } from './CodeProControlPlanePanel';
import LoadingGoose from '../LoadingGoose';
import { GitHubPullRequestPanel } from './GitHubPullRequestPanel';
import { GitHubCiStatusPanel } from './GitHubCiStatusPanel';
import { GitRepositoryPanel } from './GitRepositoryPanel';
import { TechnicalValue } from '../TechnicalValue';
import {
  formatCodeProSummaryStatus,
  formatCodeProVerificationOutcome,
} from './codeProPresentation';
import {
  collectCodeProTaskFiles,
  currentTurnTerminalRetryAction,
  focusCodeProTaskActivity,
  parseCodeProTasks,
  pausedTaskGuidance,
  retainCodeProTasks,
  selectCodeProTasks,
  selectCurrentTurnCodeProRunReport,
  summarizeCodeProTasks,
  summarizeTaskDetail,
  type CodeProTaskPanelMessage,
  type TaskCardData,
  type TurnTerminalRetryAction,
} from './codeProTaskPanelModel';

export {
  hasCodeProTaskPanelContent,
  parseCodeProRunReport,
  parseCodeProTasks,
  pausedTaskGuidance,
  retainCodeProTasks,
  selectCodeProTasks,
  selectCurrentTurnCodeProRunReport,
  summarizeCodeProTasks,
  taskOutcomeLabel,
} from './codeProTaskPanelModel';
export type { TaskCardData, TaskCardStatus } from './codeProTaskPanelModel';

export const CODEPRO_TASK_PANEL_DEFAULT_WIDTH = 340;
export const CODEPRO_TASK_PANEL_MIN_WIDTH = 320;
export const CODEPRO_TASK_PANEL_MAX_WIDTH = 480;
export const CODEPRO_TASK_PANEL_GAP = 12;
const CODEPRO_CHAT_MIN_WIDTH = 560;
const CODEPRO_TASK_PANEL_RESIZE_STEP = 32;

const i18n = defineMessages({
  openPanel: { id: 'codeProTaskPanel.openPanel', defaultMessage: 'Open CodePro task panel' },
  closePanel: { id: 'codeProTaskPanel.closePanel', defaultMessage: 'Close CodePro task panel' },
  panel: { id: 'codeProTaskPanel.panel', defaultMessage: 'CodePro tasks' },
  resizePanel: { id: 'codeProTaskPanel.resizePanel', defaultMessage: 'Resize task panel' },
  taskExecution: { id: 'codeProTaskPanel.taskExecution', defaultMessage: 'Task execution' },
  planning: { id: 'codeProTaskPanel.planning', defaultMessage: 'Planning tasks' },
  waiting: { id: 'codeProTaskPanel.waiting', defaultMessage: 'Waiting for a task' },
  collapsePanel: {
    id: 'codeProTaskPanel.collapsePanel',
    defaultMessage: 'Collapse CodePro task panel',
  },
  tasks: { id: 'codeProTaskPanel.tasks', defaultMessage: 'Tasks' },
  files: { id: 'codeProTaskPanel.files', defaultMessage: 'Files' },
  git: { id: 'codeProTaskPanel.git', defaultMessage: 'Git' },
  pullRequest: { id: 'codeProTaskPanel.pullRequest', defaultMessage: 'Pull Request' },
  pullRequestShort: { id: 'codeProTaskPanel.pullRequestShort', defaultMessage: 'PR' },
  ci: { id: 'codeProTaskPanel.ci', defaultMessage: 'CI' },
  tokenUsage: {
    id: 'codeProTaskPanel.tokenUsage',
    defaultMessage: 'Token usage: {total} (input {input} / output {output})',
  },
  knownCost: { id: 'codeProTaskPanel.knownCost', defaultMessage: 'Known cost: ${cost}' },
  runningEmpty: {
    id: 'codeProTaskPanel.runningEmpty',
    defaultMessage: 'Planning and running. Task results will appear here when ready.',
  },
  idleEmpty: {
    id: 'codeProTaskPanel.idleEmpty',
    defaultMessage: 'Enter a development goal to show task cards here.',
  },
  agentRole: { id: 'codeProTaskPanel.agentRole', defaultMessage: '{role} Agent' },
  verificationFailed: {
    id: 'codeProTaskPanel.verificationFailed',
    defaultMessage: 'Tests or checks ran and found a problem',
  },
  verificationNoTests: {
    id: 'codeProTaskPanel.verificationNoTests',
    defaultMessage: 'The test command ran, but no tests were found',
  },
  verificationEnvironment: {
    id: 'codeProTaskPanel.verificationEnvironment',
    defaultMessage:
      'A required tool or dependency is unavailable; this does not prove a project bug',
  },
  verificationCommand: {
    id: 'codeProTaskPanel.verificationCommand',
    defaultMessage: 'CodePro could not run the check command successfully',
  },
  pausedPending: {
    id: 'codeProTaskPanel.pausedPending',
    defaultMessage: 'Task paused. CodePro is determining whether it can continue.',
  },
  pausedCheckpoint: {
    id: 'codeProTaskPanel.paused',
    defaultMessage: 'Progress is saved. Use Retry below the chat message to continue',
  },
  pausedAskUser: {
    id: 'codeProTaskPanel.pausedAskUser',
    defaultMessage: 'Waiting for your input. Confirm the command, path, or permission in chat.',
  },
  pausedManualReview: {
    id: 'codeProTaskPanel.pausedManualReview',
    defaultMessage: 'Task paused for review. Automatic retry is not available.',
  },
  retry: { id: 'messageCopyLink.retry', defaultMessage: 'Retry' },
  stepPurpose: { id: 'codeProTaskPanel.stepPurpose', defaultMessage: 'What this step does' },
  loadingPurpose: {
    id: 'codeProTaskPanel.loadingPurpose',
    defaultMessage: 'Loading the detailed description…',
  },
  acceptance: { id: 'codeProTaskPanel.acceptance', defaultMessage: 'How completion is verified' },
  loadingAcceptance: {
    id: 'codeProTaskPanel.loadingAcceptance',
    defaultMessage: 'Acceptance criteria will appear here when available.',
  },
  involvedFiles: { id: 'codeProTaskPanel.involvedFiles', defaultMessage: 'Files involved' },
  noFilesYet: { id: 'codeProTaskPanel.noFilesYet', defaultMessage: 'No file changes yet' },
  noFiles: { id: 'codeProTaskPanel.noFiles', defaultMessage: 'No file changes' },
  locatedActivity: {
    id: 'codeProTaskPanel.locatedActivity',
    defaultMessage: 'Located chat activity for task {task}',
  },
  noActivity: {
    id: 'codeProTaskPanel.noActivity',
    defaultMessage: 'Task {task} has no chat activity to locate yet',
  },
  viewActivity: { id: 'codeProTaskPanel.viewActivity', defaultMessage: 'View activity in chat' },
  resultSummary: { id: 'codeProTaskPanel.resultSummary', defaultMessage: 'Result summary' },
  resultPending: {
    id: 'codeProTaskPanel.resultPending',
    defaultMessage: 'A result summary will appear when execution finishes.',
  },
  taskOpened: {
    id: 'codeProTaskPanel.taskOpened',
    defaultMessage: 'Opened details for task {task}',
  },
  workspaceApplied: {
    id: 'codeProTaskPanel.workspaceApplied',
    defaultMessage: 'Current project · Changes written',
  },
  workspaceTestOnly: {
    id: 'codeProTaskPanel.workspaceTestOnly',
    defaultMessage: 'Current project · Checks only',
  },
  workspaceLegacy: {
    id: 'codeProTaskPanel.workspaceLegacy',
    defaultMessage: 'Historical isolated task record',
  },
  workspaceAppliedDescription: {
    id: 'codeProTaskPanel.workspaceAppliedDescription',
    defaultMessage:
      'Changes were written directly to the current project and are available in the editor.',
  },
  workspaceTestOnlyDescription: {
    id: 'codeProTaskPanel.workspaceTestOnlyDescription',
    defaultMessage:
      'This run performed analysis, tests, and independent review without a coding Agent.',
  },
  workspaceLegacyDescription: {
    id: 'codeProTaskPanel.workspaceLegacyDescription',
    defaultMessage:
      'Current CodePro runs edit the current project directly; apply, discard, and isolated-project actions are no longer offered.',
  },
  projectPath: { id: 'codeProTaskPanel.projectPath', defaultMessage: 'Project path' },
});

export type CodeProTaskPanelLayout = 'inline' | 'overlay' | 'drawer';

export function clampCodeProTaskPanelWidth(
  requestedWidth: number,
  viewportWidth: number,
  layout: CodeProTaskPanelLayout = 'inline'
): number {
  const maximumWidth =
    layout === 'inline'
      ? Math.min(
          CODEPRO_TASK_PANEL_MAX_WIDTH,
          viewportWidth - CODEPRO_CHAT_MIN_WIDTH - CODEPRO_TASK_PANEL_GAP
        )
      : Math.min(
          layout === 'overlay' ? 380 : 360,
          viewportWidth - (layout === 'overlay' ? 32 : 16)
        );
  const safeMaximum = Math.max(0, maximumWidth);
  const minimumWidth = Math.min(CODEPRO_TASK_PANEL_MIN_WIDTH, safeMaximum);

  return Math.min(safeMaximum, Math.max(minimumWidth, requestedWidth));
}

export function useRetainedCodeProTasks({
  isRunning,
  progressMessage,
  sessionId,
}: {
  isRunning: boolean;
  progressMessage?: string;
  sessionId: string;
}): TaskCardData[] {
  const state = useRef<{
    isRunning: boolean;
    sessionId: string;
    tasks: TaskCardData[];
  }>({
    isRunning: false,
    sessionId,
    tasks: [],
  });
  const parsedTasks = useMemo(() => parseCodeProTasks(progressMessage ?? ''), [progressMessage]);

  if (state.current.sessionId !== sessionId) {
    state.current = { isRunning: false, sessionId, tasks: [] };
  }

  const startingNewRun = isRunning && !state.current.isRunning;
  state.current.tasks = startingNewRun
    ? parsedTasks
    : retainCodeProTasks(state.current.tasks, progressMessage ?? '');
  state.current.isRunning = isRunning;

  return state.current.tasks;
}

interface CodeProTaskPanelProps {
  expanded: boolean;
  layout?: CodeProTaskPanelLayout;
  onExpandedChange: (expanded: boolean) => void;
  onTerminalRetry?: (action: TurnTerminalRetryAction) => void | Promise<void>;
  onWidthChange: (width: number) => void;
  width: number;
}

export function CodeProTaskPanel({
  expanded,
  layout = 'inline',
  onExpandedChange,
  onTerminalRetry,
  onWidthChange,
  width,
}: CodeProTaskPanelProps) {
  const intl = useIntl();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('resumeSessionId') ?? '';
  const snapshot = useAcpChatSessionSnapshot(sessionId);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activeTab, setActiveTab] = useState<'tasks' | 'files' | 'git' | 'pull_request' | 'ci'>(
    'tasks'
  );
  const [navigationStatus, setNavigationStatus] = useState<string>();
  const [isResizing, setIsResizing] = useState(false);
  const latestReport = useMemo(
    () =>
      selectCurrentTurnCodeProRunReport((snapshot?.messages ?? []) as CodeProTaskPanelMessage[]),
    [snapshot?.messages]
  );
  const activityFiles = useMemo(
    () => collectCodeProTaskFiles((snapshot?.messages ?? []) as CodeProTaskPanelMessage[]),
    [snapshot?.messages]
  );
  const isRunning =
    snapshot?.chatState !== undefined &&
    snapshot.chatState !== ChatState.Idle &&
    latestReport === undefined;
  const parsedLiveTasks = useRetainedCodeProTasks({
    isRunning,
    progressMessage: snapshot?.progressMessage,
    sessionId,
  });
  const tasks = selectCodeProTasks({
    isRunning,
    liveTasks: parsedLiveTasks,
    reportTasks: latestReport?.tasks,
  });
  const taskSummary = useMemo(() => summarizeCodeProTasks(tasks), [tasks]);
  const pausedGuidance = useMemo(
    () => pausedTaskGuidance((snapshot?.messages ?? []) as CodeProTaskPanelMessage[]),
    [snapshot?.messages]
  );
  const terminalRetryAction = useMemo(
    () => currentTurnTerminalRetryAction((snapshot?.messages ?? []) as CodeProTaskPanelMessage[]),
    [snapshot?.messages]
  );
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const workspacePath = latestReport?.workspacePath;
  const workspaceRoot = workspacePath ?? snapshot?.session?.working_dir;
  const changesApplied = latestReport?.changesApplied ?? false;
  const testOnly = latestReport?.testOnly ?? false;
  const pullRequestProposal = useMemo(() => {
    if (!latestReport?.changesApplied) return undefined;
    const changedTasks = latestReport.tasks.filter((task) => (task.filesChanged?.length ?? 0) > 0);
    const lead = changedTasks[0] ?? latestReport.tasks[0];
    if (!lead) return undefined;
    const title = lead.name.trim().slice(0, 256);
    const body = changedTasks
      .map((task) => {
        const evidence = task.testEvidence?.trim() || task.changeReport?.trim();
        return `- ${task.name}${evidence ? `: ${evidence}` : ''}`;
      })
      .join('\n')
      .slice(0, 65_536);
    return { title, body };
  }, [latestReport]);
  const files = Array.from(
    new Set([
      ...activityFiles.map((file) => file.path),
      ...tasks.flatMap((task) => task.filesChanged ?? []),
    ])
  ).sort();
  const panelWidth = clampCodeProTaskPanelWidth(width, window.innerWidth, layout);

  const updateWidthFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    const requestedWidth = window.innerWidth - event.clientX - CODEPRO_TASK_PANEL_GAP;
    onWidthChange(clampCodeProTaskPanelWidth(requestedWidth, window.innerWidth, layout));
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      onWidthChange(CODEPRO_TASK_PANEL_DEFAULT_WIDTH);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta =
      event.key === 'ArrowLeft' ? CODEPRO_TASK_PANEL_RESIZE_STEP : -CODEPRO_TASK_PANEL_RESIZE_STEP;
    onWidthChange(clampCodeProTaskPanelWidth(width + delta, window.innerWidth, layout));
  };

  useEffect(() => {
    setSelectedTaskId(undefined);
    setActiveTab('tasks');
    setNavigationStatus(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(undefined);
    }
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (files.length === 0 && activeTab === 'files') setActiveTab('tasks');
  }, [activeTab, files.length]);

  return (
    <>
      {!expanded && (
        <button
          type="button"
          onClick={() => onExpandedChange(true)}
          className="absolute right-3 top-14 z-20 flex h-9 w-9 items-center justify-center rounded-md border border-border-primary bg-background-primary text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          aria-label={intl.formatMessage(i18n.openPanel)}
          title={intl.formatMessage(i18n.openPanel)}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {expanded && layout !== 'inline' && (
        <button
          type="button"
          className="absolute inset-0 z-10 bg-black/10"
          aria-label={intl.formatMessage(i18n.closePanel)}
          onClick={() => onExpandedChange(false)}
        />
      )}
      <aside
        className={cn(
          'absolute bottom-3 right-3 top-14 z-20 flex flex-col rounded-lg border border-border-primary bg-background-primary',
          layout === 'drawer' && 'bottom-2 right-2 top-12',
          !expanded && 'hidden'
        )}
        style={{ width: panelWidth }}
        aria-label={intl.formatMessage(i18n.panel)}
        aria-hidden={!expanded}
      >
        {layout === 'inline' && (
          <div
            role="separator"
            aria-label={intl.formatMessage(i18n.resizePanel)}
            aria-orientation="vertical"
            aria-valuemin={CODEPRO_TASK_PANEL_MIN_WIDTH}
            aria-valuemax={CODEPRO_TASK_PANEL_MAX_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            className={cn(
              'group absolute -left-1.5 bottom-0 top-0 z-30 w-3 cursor-col-resize touch-none rounded-l-lg outline-none',
              isResizing && 'bg-blue-500/10'
            )}
            onDoubleClick={() => onWidthChange(CODEPRO_TASK_PANEL_DEFAULT_WIDTH)}
            onKeyDown={resizeWithKeyboard}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setIsResizing(true);
            }}
            onPointerMove={updateWidthFromPointer}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute bottom-3 left-1/2 top-3 w-0.5 -translate-x-1/2 rounded-full bg-border-primary transition-colors group-hover:bg-blue-500 group-focus-visible:bg-blue-500',
                isResizing && 'bg-blue-500'
              )}
            />
          </div>
        )}
        <header className="flex items-center justify-between border-b border-border-primary px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {intl.formatMessage(i18n.taskExecution)}
            </h2>
            <p className="text-xs text-text-secondary">
              {tasks.length > 0
                ? `${taskSummary.completedCount}/${taskSummary.totalCount} · ${formatCodeProSummaryStatus(intl, taskSummary.status)}`
                : isRunning
                  ? intl.formatMessage(i18n.planning)
                  : intl.formatMessage(i18n.waiting)}
            </p>
            {isRunning && taskSummary.currentTask && (
              <p className="truncate text-xs text-text-secondary">{taskSummary.currentTask.name}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onExpandedChange(false)}
            className="flex h-9 w-9 items-center justify-center rounded text-text-secondary hover:bg-background-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
            aria-label={intl.formatMessage(i18n.collapsePanel)}
            title={intl.formatMessage(i18n.collapsePanel)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </header>

        <CodeProControlPlanePanel sessionId={sessionId} runId={snapshot?.activeRunId} />
        {snapshot?.chatState === ChatState.Compacting && (
          <LoadingGoose
            chatState={snapshot.chatState}
            compactionLifecycle={snapshot.compactionLifecycle}
            assistantName="CodePro"
          />
        )}
        <div className="grid grid-cols-5 border-b border-border-primary p-1">
          <button
            type="button"
            onClick={() => setActiveTab('tasks')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs',
              activeTab === 'tasks'
                ? 'bg-background-secondary text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            )}
            aria-pressed={activeTab === 'tasks'}
          >
            <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(i18n.tasks)}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('files')}
            disabled={files.length === 0}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs',
              activeTab === 'files'
                ? 'bg-background-secondary text-text-primary'
                : 'text-text-secondary hover:text-text-primary',
              files.length === 0 && 'cursor-not-allowed opacity-50 hover:text-text-secondary'
            )}
            aria-pressed={activeTab === 'files'}
          >
            <Files className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(i18n.files)} {files.length > 0 ? `(${files.length})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('git')}
            disabled={!workspaceRoot || !sessionId}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs',
              activeTab === 'git'
                ? 'bg-background-secondary text-text-primary'
                : 'text-text-secondary hover:text-text-primary',
              (!workspaceRoot || !sessionId) &&
                'cursor-not-allowed opacity-50 hover:text-text-secondary'
            )}
            aria-pressed={activeTab === 'git'}
          >
            <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(i18n.git)}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('pull_request')}
            aria-label={intl.formatMessage(i18n.pullRequest)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs',
              activeTab === 'pull_request'
                ? 'bg-background-secondary text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            )}
            aria-pressed={activeTab === 'pull_request'}
          >
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(i18n.pullRequestShort)}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ci')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs',
              activeTab === 'ci'
                ? 'bg-background-secondary text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            )}
            aria-pressed={activeTab === 'ci'}
          >
            <Workflow className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(i18n.ci)}
          </button>
        </div>

        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col p-3',
            activeTab === 'files' ? 'overflow-hidden' : 'overflow-y-auto'
          )}
        >
          {activeTab === 'files' ? (
            <CodeProFileViewer files={files} workspaceRoot={workspaceRoot} />
          ) : activeTab === 'git' ? (
            <GitRepositoryPanel sessionId={sessionId} workingDirectory={workspaceRoot} />
          ) : activeTab === 'pull_request' ? (
            <GitHubPullRequestPanel
              workingDirectory={workspaceRoot}
              suggestedTitle={pullRequestProposal?.title}
              suggestedBody={pullRequestProposal?.body}
            />
          ) : activeTab === 'ci' ? (
            <GitHubCiStatusPanel workingDirectory={workspaceRoot} />
          ) : (
            <>
              {terminalRetryAction && onTerminalRetry && (
                <div className="mb-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void onTerminalRetry(terminalRetryAction)}
                    className="flex items-center gap-1.5 rounded-md border border-border-primary bg-background-secondary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-background-primary"
                    aria-label={intl.formatMessage(i18n.retry)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    {intl.formatMessage(i18n.retry)}
                  </button>
                </div>
              )}
              {latestReport?.usage && (
                <div className="mb-3 rounded-md border border-border-primary bg-background-secondary p-2 text-xs text-text-secondary">
                  <p>
                    {intl.formatMessage(i18n.tokenUsage, {
                      total: latestReport.usage.totalTokens.toLocaleString(),
                      input: latestReport.usage.inputTokens.toLocaleString(),
                      output: latestReport.usage.outputTokens.toLocaleString(),
                    })}
                  </p>
                  {latestReport.usage.costUsd !== undefined && (
                    <p className="mt-1">
                      {intl.formatMessage(i18n.knownCost, {
                        cost: latestReport.usage.costUsd.toFixed(4),
                      })}
                    </p>
                  )}
                </div>
              )}
              {tasks.length === 0 ? (
                <div className="rounded-md border border-dashed border-border-primary p-4 text-sm text-text-secondary">
                  {isRunning
                    ? intl.formatMessage(i18n.runningEmpty)
                    : intl.formatMessage(i18n.idleEmpty)}
                </div>
              ) : (
                <ol className="divide-y divide-border-primary overflow-hidden rounded-md border border-border-primary">
                  {tasks.map((task) => {
                    const verificationFoundProblem =
                      task.verificationOutcome === 'failed' ||
                      task.verificationOutcome === 'no_tests' ||
                      task.verificationOutcome === 'environment_unavailable' ||
                      task.verificationOutcome === 'command_failed';
                    const Icon = verificationFoundProblem
                      ? AlertTriangle
                      : task.status === 'passed'
                        ? Check
                        : task.status === 'failed'
                          ? X
                          : task.status === 'skipped'
                            ? ChevronRight
                            : task.status === 'paused'
                              ? Ban
                              : task.status === 'cancelled'
                                ? Ban
                                : CircleDashed;
                    return (
                      <li key={`${task.id}-${task.name}`} className="bg-background-primary">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedTaskId((current) =>
                              current === task.id ? undefined : task.id
                            )
                          }
                          className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-background-secondary"
                          aria-expanded={selectedTaskId === task.id}
                        >
                          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-primary bg-background-secondary">
                            <Icon
                              className={cn(
                                'h-3.5 w-3.5 shrink-0',
                                verificationFoundProblem
                                  ? 'text-amber-600'
                                  : task.status === 'passed'
                                    ? 'text-green-600'
                                    : task.status === 'failed'
                                      ? 'text-red-600'
                                      : task.status === 'skipped'
                                        ? 'text-text-secondary'
                                        : task.status === 'paused'
                                          ? 'text-amber-600'
                                          : task.status === 'cancelled'
                                            ? 'text-amber-600'
                                            : task.status === 'running'
                                              ? 'animate-spin text-text-secondary'
                                              : 'text-text-secondary'
                              )}
                              aria-hidden="true"
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-text-primary">{task.name}</p>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
                              <span>
                                {formatCodeProVerificationOutcome(
                                  intl,
                                  task.verificationOutcome,
                                  task.status
                                )}
                              </span>
                            </div>
                            {task.verificationOutcome === 'failed' && (
                              <p className="mt-0.5 text-xs text-amber-700">
                                {intl.formatMessage(i18n.verificationFailed)}
                              </p>
                            )}
                            {task.verificationOutcome === 'no_tests' && (
                              <p className="mt-0.5 text-xs text-amber-700">
                                {intl.formatMessage(i18n.verificationNoTests)}
                              </p>
                            )}
                            {task.verificationOutcome === 'environment_unavailable' && (
                              <p className="mt-0.5 text-xs text-amber-700">
                                {intl.formatMessage(i18n.verificationEnvironment)}
                              </p>
                            )}
                            {task.verificationOutcome === 'command_failed' && (
                              <p className="mt-0.5 text-xs text-amber-700">
                                {intl.formatMessage(i18n.verificationCommand)}
                              </p>
                            )}
                            {task.status === 'paused' && (
                              <p className="mt-0.5 text-xs text-amber-700">
                                {intl.formatMessage(
                                  pausedGuidance === 'continue_checkpoint'
                                    ? i18n.pausedCheckpoint
                                    : pausedGuidance === 'ask_user'
                                      ? i18n.pausedAskUser
                                      : pausedGuidance === 'manual_review'
                                        ? i18n.pausedManualReview
                                        : i18n.pausedPending
                                )}
                              </p>
                            )}
                          </div>
                        </button>
                        {selectedTaskId === task.id && (
                          <div className="space-y-3 border-t border-border-primary bg-background-secondary px-3 py-3 text-xs">
                            <div>
                              <p className="font-medium text-text-primary">
                                {intl.formatMessage(i18n.stepPurpose)}
                              </p>
                              <p className="mt-1 leading-5 text-text-secondary">
                                {task.description ?? intl.formatMessage(i18n.loadingPurpose)}
                              </p>
                            </div>
                            <div>
                              <p className="font-medium text-text-primary">
                                {intl.formatMessage(i18n.acceptance)}
                              </p>
                              <p className="mt-1 leading-5 text-text-secondary">
                                {task.acceptanceCriteria ??
                                  intl.formatMessage(i18n.loadingAcceptance)}
                              </p>
                            </div>
                            <div>
                              <p className="font-medium text-text-primary">
                                {intl.formatMessage(i18n.involvedFiles)}
                              </p>
                              <p className="mt-1 break-all text-text-secondary">
                                {task.filesChanged?.length
                                  ? task.filesChanged.join('、')
                                  : isRunning
                                    ? intl.formatMessage(i18n.noFilesYet)
                                    : intl.formatMessage(i18n.noFiles)}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="rounded-md border border-border-primary bg-background-primary px-2.5 py-1.5 font-medium text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
                              onClick={() => {
                                const found = focusCodeProTaskActivity(
                                  task.id,
                                  document,
                                  sessionId
                                );
                                setNavigationStatus(
                                  found
                                    ? intl.formatMessage(i18n.locatedActivity, { task: task.name })
                                    : intl.formatMessage(i18n.noActivity, { task: task.name })
                                );
                              }}
                            >
                              {intl.formatMessage(i18n.viewActivity)}
                            </button>
                            <div>
                              <p className="font-medium text-text-primary">
                                {intl.formatMessage(i18n.resultSummary)}
                              </p>
                              <p className="mt-1 line-clamp-2 text-text-secondary">
                                {isRunning && !task.testEvidence && !task.changeReport
                                  ? intl.formatMessage(i18n.resultPending)
                                  : task.testEvidence || task.changeReport
                                    ? summarizeTaskDetail(task)
                                    : formatCodeProVerificationOutcome(
                                        intl,
                                        task.verificationOutcome,
                                        task.status
                                      )}
                              </p>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
        {selectedTask && (
          <p className="sr-only" role="status">
            {intl.formatMessage(i18n.taskOpened, { task: selectedTask.name })}
          </p>
        )}
        {navigationStatus && (
          <p className="sr-only" role="status">
            {navigationStatus}
          </p>
        )}
        {workspacePath && (
          <footer className="border-t border-border-primary p-3">
            <details className="text-xs text-text-secondary">
              <summary className="cursor-pointer rounded font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary">
                {changesApplied
                  ? intl.formatMessage(i18n.workspaceApplied)
                  : testOnly
                    ? intl.formatMessage(i18n.workspaceTestOnly)
                    : intl.formatMessage(i18n.workspaceLegacy)}
              </summary>
              <p className="mt-2">
                {changesApplied
                  ? intl.formatMessage(i18n.workspaceAppliedDescription)
                  : testOnly
                    ? intl.formatMessage(i18n.workspaceTestOnlyDescription)
                    : intl.formatMessage(i18n.workspaceLegacyDescription)}
              </p>
              <div className="mt-2">
                <TechnicalValue
                  value={workspacePath}
                  label={intl.formatMessage(i18n.projectPath)}
                />
              </div>
            </details>
          </footer>
        )}
      </aside>
    </>
  );
}
