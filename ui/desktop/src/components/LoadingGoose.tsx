import GooseLogo from './GooseLogo';
import { CircleStop, FileSearch, Layers3, Link2, ListChecks, ListTree, Settings2, UsersRound } from 'lucide-react';
import AnimatedIcons from './AnimatedIcons';
import ConversationSpinner from './ConversationSpinner';
import { ToolActivityIcon } from './ToolActivityIcon';
import { ChatState } from '../types/chatState';
import { defineMessages, useIntl } from '../i18n';
import { useEffect, useState } from 'react';
import type { CompactionLifecycle } from '../types/compactionLifecycle';
import type { selectWorkStatus } from './codepro/useWorkStatus';

type WorkStatusSource = ReturnType<typeof selectWorkStatus>['source'];

interface LoadingGooseProps {
  message?: string;
  hint?: string;
  announcement?: string;
  chatState?: ChatState;
  assistantName?: 'Code' | 'CodePro';
  compactionLifecycle?: CompactionLifecycle;
  showElapsed?: boolean;
  workStatusSource?: WorkStatusSource;
  activeToolName?: string;
}

export function getLoadingIndicatorPresentation(
  pathname: string,
  progressMessage?: string
): Pick<LoadingGooseProps, 'assistantName' | 'message'> {
  const isCodePro = pathname === '/codepro' || pathname.startsWith('/codepro/');
  const codeProHeadline = progressMessage?.split(/\r?\n/, 1)[0]?.trim();
  return {
    assistantName: isCodePro ? 'CodePro' : 'Code',
    message: isCodePro ? codeProHeadline || undefined : progressMessage,
  };
}

// Exact host progress notices from supported backend locales. This affects
// presentation only; completion remains owned by the backend control plane.
export function isCheckingExecutionResults(message?: string): boolean {
  return (
    message === 'Checking execution results…' ||
    message === '正在核验执行结果…' ||
    message === '正在核驗執行結果…'
  );
}

const i18n = defineMessages({
  compactionHint: { id: 'loadingGoose.compactionHint', defaultMessage: 'Generating a continuation summary. Original messages remain in this conversation.' },
  compactionWait: { id: 'loadingGoose.compactionWait', defaultMessage: 'Still waiting for the model. Large conversations may take longer; you can stop and retry.' },
  loadingConversation: {
    id: 'loadingGoose.loadingConversation',
    defaultMessage: 'Loading conversation…',
  },
  thinking: {
    id: 'loadingGoose.thinking',
    defaultMessage: 'CodeBuddy is thinking…',
  },
  streaming: {
    id: 'loadingGoose.streaming',
    defaultMessage: 'CodeBuddy is working on it…',
  },
  waiting: {
    id: 'loadingGoose.waiting',
    defaultMessage: 'CodeBuddy is waiting…',
  },
  compacting: {
    id: 'loadingGoose.compacting',
    defaultMessage: 'CodeBuddy is compacting the conversation...',
  },
  compactingElapsed: {
    id: 'loadingGoose.compactingElapsed',
    defaultMessage: 'Organizing conversation context {seconds}s',
  },
  elapsed: {
    id: 'loadingGoose.elapsed',
    defaultMessage: '{message} {seconds}s elapsed',
  },
  idle: {
    id: 'loadingGoose.idle',
    defaultMessage: 'CodeBuddy is working on it…',
  },
  restartingAgent: {
    id: 'loadingGoose.restartingAgent',
    defaultMessage: 'restarting session...',
  },
});

const STATE_ICONS: Record<ChatState, React.ReactNode> = {
  [ChatState.LoadingConversation]: <ConversationSpinner />,
  [ChatState.Thinking]: <AnimatedIcons className="flex-shrink-0" />,
  [ChatState.Streaming]: <AnimatedIcons className="flex-shrink-0" variant="streaming" />,
  [ChatState.WaitingForUserInput]: (
    <AnimatedIcons className="flex-shrink-0" variant="question" />
  ),
  [ChatState.Compacting]: <AnimatedIcons className="flex-shrink-0" variant="compacting" />,
  [ChatState.Idle]: <GooseLogo size="small" hover={false} />,
  [ChatState.RestartingAgent]: <AnimatedIcons className="flex-shrink-0" variant="waiting" />,
};

function workStatusIcon(source: WorkStatusSource, toolName?: string): React.ReactNode {
  const neutralIcon = 'size-4 shrink-0 text-text-secondary';
  switch (source) {
    case 'tool':
    case 'toolInput':
      return toolName ? <ToolActivityIcon name={toolName} status="loading" animated={false} /> : <ConversationSpinner />;
    case 'text':
    case 'responseRead':
      return <AnimatedIcons variant="streaming" animated={false} />;
    case 'thought':
      return <AnimatedIcons variant="thinking" />;
    case 'question':
    case 'approval':
      return <AnimatedIcons variant="question" animated={false} />;
    case 'children':
      return <UsersRound className={neutralIcon} aria-hidden="true" />;
    case 'childResult':
      return <Layers3 className={neutralIcon} aria-hidden="true" />;
    case 'toolResult':
      return <FileSearch className={neutralIcon} aria-hidden="true" />;
    case 'check':
      return <ListChecks className={neutralIcon} aria-hidden="true" />;
    case 'stage':
      return <ListTree className={neutralIcon} aria-hidden="true" />;
    case 'preparing':
      return <Settings2 className="size-4 shrink-0 text-text-secondary motion-safe:animate-spin [animation-duration:4s]" aria-hidden="true" />;
    case 'connecting':
      return <Link2 className={neutralIcon} aria-hidden="true" />;
    case 'responseWait':
    case 'first':
      return <ConversationSpinner />;
    case 'cancel':
      return <CircleStop className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />;
    case 'chat_state':
      return undefined;
  }
}

const STATE_MESSAGE_KEYS: Record<ChatState, keyof typeof i18n> = {
  [ChatState.LoadingConversation]: 'loadingConversation',
  [ChatState.Thinking]: 'thinking',
  [ChatState.Streaming]: 'streaming',
  [ChatState.WaitingForUserInput]: 'waiting',
  [ChatState.Compacting]: 'compacting',
  [ChatState.Idle]: 'idle',
  [ChatState.RestartingAgent]: 'restartingAgent',
};

const LoadingGoose = ({
  message,
  hint,
  announcement,
  chatState = ChatState.Idle,
  assistantName = 'Code',
  compactionLifecycle,
  showElapsed = false,
  workStatusSource,
  activeToolName,
}: LoadingGooseProps) => {
  const intl = useIntl();
  const [now, setNow] = useState(Date.now);
  const [stageStartedAt, setStageStartedAt] = useState(Date.now);
  const compacting =
    compactionLifecycle?.status === 'started' && chatState === ChatState.Compacting;
  useEffect(() => {
    setStageStartedAt(Date.now());
  }, [message, chatState]);
  useEffect(() => {
    if (!compacting && !showElapsed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [compacting, showElapsed]);
  const localizedStateMessage = intl.formatMessage(i18n[STATE_MESSAGE_KEYS[chatState]]);
  const displayMessage = compacting
    ? intl.formatMessage(i18n.compactingElapsed, {
        seconds: Math.max(0, Math.floor((now - Date.parse(compactionLifecycle.startedAt)) / 1000)),
      })
    : message || localizedStateMessage.replace(/CodeBuddy/g, assistantName);
  const icon = (workStatusSource && workStatusIcon(workStatusSource, activeToolName)) || STATE_ICONS[chatState];

  if (compacting) return (
    <div data-testid="loading-indicator" role="status" aria-live="polite" aria-busy="true"
      className="my-2 overflow-hidden rounded-xl border border-border-primary bg-background-secondary/50">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Layers3 className="mt-0.5 size-4 shrink-0 text-text-secondary motion-safe:animate-pulse" />
        <div className="min-w-0 space-y-1">
          <span className="sr-only">{intl.formatMessage(i18n.compacting)}</span>
          <p aria-hidden="true" className="text-xs font-medium text-text-primary">{displayMessage}</p>
          <p className="text-xs leading-relaxed text-text-secondary">{intl.formatMessage(i18n.compactionHint)}</p>
          {now - Date.parse(compactionLifecycle.startedAt) >= 30000 && (
            <p className="text-xs leading-relaxed text-text-secondary">{intl.formatMessage(i18n.compactionWait)}</p>
          )}
        </div>
      </div>
      <div aria-hidden="true" className="h-0.5 bg-border-primary/40">
        <div className="h-full w-1/3 bg-text-secondary/35 motion-safe:animate-pulse" />
      </div>
    </div>
  );

  return (
    <div className="w-full animate-fade-slide-up">
      <div
        data-testid="loading-indicator"
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="flex items-center gap-2 py-1.5 text-sm text-text-primary"
      >
        <span
          key={`${workStatusSource ?? chatState}:${activeToolName ?? ''}`}
          aria-hidden="true"
          className="work-status-icon inline-grid size-6 shrink-0 place-items-center text-text-secondary"
        >
          {icon}
        </span>
        <span className="min-w-0 truncate" title={displayMessage}>
          {showElapsed &&
          !compacting &&
          (chatState === ChatState.Thinking || chatState === ChatState.Streaming) ? (
            <>
              <span className="sr-only">{displayMessage}</span>
              {/* Elapsed seconds are visual feedback, not repeated live announcements. */}
              <span aria-hidden="true">
                {intl.formatMessage(i18n.elapsed, {
                  message: displayMessage,
                  seconds: Math.max(0, Math.floor((now - stageStartedAt) / 1000)),
                })}
              </span>
            </>
          ) : announcement && announcement !== displayMessage && !compacting ? (
            <>
              <span className="sr-only">{announcement}</span>
              <span aria-hidden="true">{displayMessage}</span>
            </>
          ) : (
            displayMessage
          )}
        </span>
      </div>
      {hint && (
        <p
          data-testid="wait-hint"
          className="pb-2 pl-8 text-xs leading-relaxed text-text-secondary"
        >
          {hint}
        </p>
      )}
    </div>
  );
};

export default LoadingGoose;
