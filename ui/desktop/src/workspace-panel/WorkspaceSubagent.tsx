import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { Message } from '../types/message';
import ProgressiveMessageList from '../components/ProgressiveMessageList';
import { SubagentAvatar } from '../components/SubagentAvatar';
import { openSubagentCatalog } from './subagentPanel';
import {
  createSubagentConversationProjection,
  readSubagentConversation,
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
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let afterSeq = -1;
    const projection = createSubagentConversationProjection(childSessionId);
    setMessages([]);
    setStatus(undefined);
    setError('');
    setTruncated(false);
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
        // Only the visible tab mounts this reader. Poll committed records; never
        // follow/resume/cancel a child or acquire its execution scope.
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
          timer = setTimeout(() => void read(), 5000);
        }
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [parentSessionId, childSessionId, ancestorSessionIds, revision]);
  const scrollToTail = useCallback(() => {
    if (following.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  useEffect(scrollToTail, [messages, scrollToTail]);
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
        <span role="status">{intl.formatMessage(m.status, { state: status ?? 'unknown' })}</span>
        <span className="text-text-secondary">{intl.formatMessage(m.readonly)}</span>
        <button
          type="button"
          className="wb-icon"
          aria-label={intl.formatMessage(m.refresh)}
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {error && (
        <p role="alert" className="p-3 text-xs text-red-600">
          {messages.length > 0 && <span className="mb-1 block">{intl.formatMessage(m.stale)}</span>}
          {error}
        </p>
      )}
      {truncated && (
        <p className="px-3 py-1 text-xs text-text-secondary">{intl.formatMessage(m.truncated)}</p>
      )}
      <div
        ref={scroller}
        className="codepro-chat-history min-h-0 flex-1 overflow-auto p-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length ? (
          <ProgressiveMessageList
            messages={messages}
            chat={{ sessionId: childSessionId }}
            sessionType="code_pro"
            readOnly
            isUserMessage={(message) => message.role === 'user'}
            foldTurns={false}
            isStreamingMessage={false}
            onRenderingComplete={scrollToTail}
          />
        ) : (
          <p className="py-4 text-sm text-text-secondary">{intl.formatMessage(m.empty)}</p>
        )}
      </div>
    </section>
  );
}
