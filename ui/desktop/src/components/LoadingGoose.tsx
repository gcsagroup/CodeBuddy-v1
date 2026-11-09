import GooseLogo from './GooseLogo';
import { Layers3 } from 'lucide-react';
import AnimatedIcons from './AnimatedIcons';
import { ChatState } from '../types/chatState';
import { defineMessages, useIntl } from '../i18n';
import { useEffect, useState } from 'react';
import type { CompactionLifecycle } from '../types/compactionLifecycle';

interface LoadingGooseProps {
  message?: string;
  hint?: string;
  announcement?: string;
  chatState?: ChatState;
  assistantName?: 'Code' | 'CodePro';
  compactionLifecycle?: CompactionLifecycle;
  showElapsed?: boolean;
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
  [ChatState.LoadingConversation]: <AnimatedIcons className="flex-shrink-0" cycleInterval={600} />,
  [ChatState.Thinking]: <AnimatedIcons className="flex-shrink-0" cycleInterval={600} />,
  [ChatState.Streaming]: <AnimatedIcons className="flex-shrink-0" cycleInterval={300} />,
  [ChatState.WaitingForUserInput]: (
    <AnimatedIcons className="flex-shrink-0" cycleInterval={600} variant="waiting" />
  ),
  [ChatState.Compacting]: <AnimatedIcons className="flex-shrink-0" cycleInterval={600} />,
  [ChatState.Idle]: <GooseLogo size="small" hover={false} />,
  [ChatState.RestartingAgent]: <AnimatedIcons className="flex-shrink-0" cycleInterval={600} />,
};

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
  const icon = STATE_ICONS[chatState];

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
        className="flex items-center gap-2 text-xs text-text-primary py-2"
      >
        {icon}
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
          className="pb-2 pl-6 text-xs leading-relaxed text-text-secondary"
        >
          {hint}
        </p>
      )}
    </div>
  );
};

export default LoadingGoose;
