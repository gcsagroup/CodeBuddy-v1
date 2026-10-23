import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { Message } from '../types/message';
import ProgressiveMessageList from '../components/ProgressiveMessageList';
import LoadingGoose from '../components/LoadingGoose';
import { ToolInputPreview } from '../components/ToolInputPreview';
import { useWorkStatus } from '../components/codepro/useWorkStatus';
import { formatToolAction } from '../components/toolActionPresentation';
import { ChatState } from '../types/chatState';
import { ScrollArea, type ScrollAreaHandle } from '../components/ui/scroll-area';
import { SubagentAvatar } from '../components/SubagentAvatar';
import { openSubagentCatalog } from './subagentPanel';
import { usePreloadedSubagentConversation } from './WorkspaceSubagents';
import {
  createSubagentConversationProjection,
  readSubagentConversation,
  watchSubagentConversation,
} from '../acp/subagentConversation';

const m = defineMessages({
  title: { id: 'workspaceSubagent.title', defaultMessage: 'Subagent conversation' },
  all: { id: 'workspaceSubagent.all', defaultMessage: 'All subagents' },
  readonly: { id: 'workspaceSubagent.readonly', defaultMessage: 'Read only' },
  empty: { id: 'workspaceSubagent.empty', defaultMessage: 'No conversation records yet.' },
  refresh: { id: 'workspaceSubagent.refresh', defaultMessage: 'Refresh conversation' },
  status: {
    id: 'workspaceSubagent.status',
    defaultMessage:
      '{state, select, running {Turn record still open} completed {Turn ended} failed {Turn failed} interrupted {Turn interrupted} other {Status not yet available}}',
  },
  truncated: {
    id: 'workspaceSubagent.truncated',
    defaultMessage: 'Some long records are shortened.',
  },
  stale: {
    id: 'workspaceSubagent.stale',
    defaultMessage: 'Reading failed. Previously loaded conversation records are retained below.',
  },
});

export function WorkspaceSubagent({
  parentSessionId,
  childSessionId,
  title,
  ancestorSessionIds,
}: {
  parentSessionId: string;
  childSessionId: string;
  title: string;
  ancestorSessionIds?: string[];
}) {
  const intl = useIntl();
  const [revision, refresh] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [followError, setFollowError] = useState<{ key: string; message: string }>();
  const viewKey = JSON.stringify([parentSessionId, childSessionId, ancestorSessionIds ?? []]);
  const [liveView, setLiveView] = useState<{
    key: string;
    messages: Message[];
    status?: string;
    error: string;
    truncated: boolean;
    loading: boolean;
    streaming: boolean;
    activity?: ReturnType<typeof createSubagentConversationProjection>['activity'];
    pendingTool?: ReturnType<typeof createSubagentConversationProjection>['pendingTool'];
  }>();
  const streamReady = liveView?.key === viewKey;
  const preloaded = usePreloadedSubagentConversation(
    parentSessionId,
    childSessionId,
    ancestorSessionIds
  );
  const managed = preloaded !== undefined;
  const displayed = streamReady
    ? liveView
    : managed
      ? {
          messages: preloaded.snapshot?.messages ?? [],
          status: preloaded.snapshot?.turn?.status,
          error: preloaded.snapshot?.error ?? '',
          truncated: preloaded.snapshot?.truncated ?? false,
          loading: preloaded.snapshot === null,
        }
      : { messages, status, error, truncated, loading };
  const visibleError = displayed.error || (followError?.key === viewKey ? followError.message : '');
  const activity = streamReady && !visibleError ? liveView.activity : undefined;
  const pendingTool = activity && liveView?.pendingTool;
  const action = pendingTool
    ? formatToolAction(intl, pendingTool.name, pendingTool.arguments, 'running', 'headline')
    : activity?.kind === 'tool' && !activity.execution?.toolInput
      ? intl.formatMessage(
          { id: 'toolAction.generating', defaultMessage: 'Preparing operation parameters{target}' },
          { target: '' }
        )
      : undefined;
  const workStatus = useWorkStatus({
    chatState: activity ? ChatState.Streaming : ChatState.Idle,
    activity,
    action,
    actionId: pendingTool?.id,
    toolPending: Boolean(pendingTool),
    checking: false,
  });
  const scroller = useRef<ScrollAreaHandle>(null);
  const [atLatest, setAtLatest] = useState(true);
  useEffect(() => {
    let projection = createSubagentConversationProjection(childSessionId);
    let ready = false;
    const publish = (error = '') =>
      setLiveView({
        key: viewKey,
        messages: projection.messages,
        status: error ? undefined : projection.status,
        error,
        truncated: false,
        loading: false,
        streaming: !error && projection.streaming,
        activity: projection.activity,
        pendingTool: projection.pendingTool,
      });
    return watchSubagentConversation(
      parentSessionId,
      childSessionId,
      ancestorSessionIds,
      (update) => {
        if (update.type === 'reset') {
          projection = createSubagentConversationProjection(childSessionId);
          ready = false;
          setLiveView((previous) =>
            previous?.key === viewKey
              ? { ...previous, activity: undefined, pendingTool: undefined, streaming: false }
              : previous
          );
        }
        if (update.events?.length) projection.append(update.events, ready);
        if (update.type === 'ready') {
          setFollowError(undefined);
          ready = true;
          if (update.active) {
            projection.stream({ type: 'start', ...update.active });
            for (const chunk of update.active.chunks)
              projection.stream({ type: 'chunk', attemptId: update.active.attemptId, chunk });
          }
        }
        if (update.frame) projection.stream(update.frame);
        if (update.type === 'error') {
          setFollowError({
            key: viewKey,
            message: update.message ?? 'Subagent observation failed',
          });
          setLiveView((previous) =>
            previous?.key === viewKey
              ? {
                  ...previous,
                  status: undefined,
                  activity: undefined,
                  pendingTool: undefined,
                  streaming: false,
                  error: update.message ?? '',
                }
              : undefined
          );
        } else if (ready) publish();
      }
    );
  }, [parentSessionId, childSessionId, ancestorSessionIds, viewKey, revision]);
  useEffect(() => {
    if (managed || streamReady) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let afterSeq = -1;
    const projection = createSubagentConversationProjection(childSessionId);
    setMessages([]);
    setStatus(undefined);
    setError('');
    setTruncated(false);
    setLoading(true);
    const read = async () => {
      try {
        const page = ancestorSessionIds
          ? await readSubagentConversation(
              parentSessionId,
              childSessionId,
              afterSeq,
              ancestorSessionIds
            )
          : await readSubagentConversation(parentSessionId, childSessionId, afterSeq);
        if (disposed) return;
        const changed = page.events.length > 0;
        afterSeq = page.throughSeq;
        if (changed) setMessages(projection.append(page.events));
        if (page.events.some((event) => event.truncated)) setTruncated(true);
        setStatus(projection.status);
        setError('');
        if (!page.hasMore) setLoading(false);
        // Compatibility fallback for a failed/unavailable live observer. This
        // reader only inspects committed records and never acquires execution.
        timer = setTimeout(
          () => void read(),
          page.hasMore
            ? 0
            : projection.status === 'running' || projection.status === undefined
              ? 1500
              : 5000
        );
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setStatus(undefined);
          setLoading(false);
          timer = setTimeout(() => void read(), 5000);
        }
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [parentSessionId, childSessionId, ancestorSessionIds, revision, managed, streamReady]);
  const scrollToTail = useCallback(() => {
    if (scroller.current?.isFollowing) scroller.current.scrollToBottom();
  }, []);
  return (
    <section
      aria-label={intl.formatMessage(m.title)}
      className="codepro-conversation flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-primary px-3 py-2 text-xs">
        <button
          type="button"
          className="wb-icon"
          aria-label={intl.formatMessage(m.all)}
          onClick={() => openSubagentCatalog(parentSessionId)}
        >
          <ArrowLeft size={14} />
        </button>
        <SubagentAvatar sessionId={childSessionId} small />
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        {!displayed.loading && (
          <span role="status">
            {intl.formatMessage(m.status, { state: displayed.status ?? 'unknown' })}
          </span>
        )}
        <span className="text-text-secondary">{intl.formatMessage(m.readonly)}</span>
        <button
          type="button"
          className="wb-icon"
          aria-label={intl.formatMessage(m.refresh)}
          onClick={() => {
            preloaded?.refresh();
            refresh((value) => value + 1);
          }}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {visibleError && (
        <p role="alert" className="p-3 text-xs text-red-600">
          {displayed.messages.length > 0 && (
            <span className="mb-1 block">{intl.formatMessage(m.stale)}</span>
          )}
          {visibleError}
        </p>
      )}
      {displayed.truncated && (
        <p className="px-3 py-1 text-xs text-text-secondary">{intl.formatMessage(m.truncated)}</p>
      )}
      <div className="relative flex min-h-0 flex-1">
        <ScrollArea
          key={viewKey}
          ref={scroller}
          autoScroll
          onBottomChange={setAtLatest}
          className="codepro-chat-history min-h-0 flex-1"
          paddingX={3}
          paddingY={3}
        >
          <div className="mx-auto w-full max-w-[52rem]">
            {displayed.loading ? (
              <p role="status" className="py-4 text-sm text-text-secondary">
                {intl.formatMessage({
                  id: 'workspaceSubagents.loading',
                  defaultMessage: 'Loading subagents…',
                })}
              </p>
            ) : displayed.messages.length ? (
              <ProgressiveMessageList
                messages={displayed.messages}
                chat={{ sessionId: childSessionId }}
                sessionType="code_pro"
                readOnly
                isUserMessage={(message) => message.role === 'user'}
                foldTurns={false}
                showLoadingThreshold={Number.MAX_SAFE_INTEGER}
                isStreamingMessage={Boolean(activity)}
                activeToolCallIds={pendingTool ? [pendingTool.id] : []}
                thinkingActivity={
                  activity?.kind === 'thought'
                    ? {
                        messageId: `child-live:${activity.promptAttemptId}`,
                        receivedAt: activity.receivedAt ?? activity.startedAt,
                      }
                    : undefined
                }
                onRenderingComplete={scrollToTail}
              />
            ) : !visibleError ? (
              <p className="py-4 text-sm text-text-secondary">{intl.formatMessage(m.empty)}</p>
            ) : null}
            {activity?.execution?.toolInput && !pendingTool && (
              <ToolInputPreview preview={activity.execution.toolInput} />
            )}
          </div>
        </ScrollArea>
        {!atLatest && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border-primary bg-background-primary shadow-sm"
            aria-label={intl.formatMessage({
              id: 'baseChat.latest',
              defaultMessage: 'Back to latest',
            })}
            onClick={() => scroller.current?.scrollToBottom()}
          >
            <ArrowDown size={16} />
          </button>
        )}
      </div>
      {activity && (
        <div className="shrink-0 px-3">
          <LoadingGoose
            chatState={ChatState.Streaming}
            message={workStatus.message}
            announcement={workStatus.announcement}
            hint={workStatus.hint}
            assistantName="CodePro"
          />
        </div>
      )}
    </section>
  );
}
