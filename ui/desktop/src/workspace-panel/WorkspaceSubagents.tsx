import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { readSubagentCatalog, type SubagentCatalogEntry } from '../acp/subagentCatalog';
import { openSubagentConversation } from './subagentPanel';
import { SubagentAvatar } from '../components/SubagentAvatar';
import { formatSubagentLabel } from '../components/toolActionPresentation';
import {
  createSubagentConversationProjection,
  readSubagentConversation,
  subagentTurnEvent,
} from '../acp/subagentConversation';
import { AppEvents } from '../constants/events';
import type { Message } from '../types/message';
import { conversationChangeMessages } from '../components/codepro/conversationChanges';

export const subagentsMessages = defineMessages({
  title: { id: 'workspaceSubagents.title', defaultMessage: 'Subagents' },
  refresh: { id: 'workspaceSubagents.refresh', defaultMessage: 'Refresh subagents' },
  loading: { id: 'workspaceSubagents.loading', defaultMessage: 'Loading subagents…' },
  empty: { id: 'workspaceSubagents.empty', defaultMessage: 'No subagents in this directory.' },
  external: { id: 'workspaceSubagents.external', defaultMessage: 'External agent' },
  unknown: { id: 'workspaceSubagents.unknown', defaultMessage: 'Conversation unavailable' },
  running: { id: 'workspaceSubagents.running', defaultMessage: 'Running · {count}' },
  ended: { id: 'workspaceSubagents.ended', defaultMessage: 'Ended · {count}' },
  unknownState: {
    id: 'workspaceSubagents.unknownState',
    defaultMessage: 'Status unknown · {count}',
  },
  noRunning: { id: 'workspaceSubagents.noRunning', defaultMessage: 'No subagents running' },
  stale: {
    id: 'workspaceSubagents.stale',
    defaultMessage:
      'The directory could not be refreshed. Previously loaded entries are shown below.',
  },
});

const ROOT_PATH: string[] = [];

type SubagentTurn = ReturnType<typeof subagentTurnEvent>;
interface SubagentObservationSnapshot {
  turn: SubagentTurn;
  messages: Message[];
  truncated: boolean;
  error?: string;
}
// null is a pending display read; a settled snapshot may have no native turn fact.
type SubagentObservationValue = SubagentObservationSnapshot | null;

function SubagentObservation({
  parentSessionId,
  childSessionId,
  ancestors,
  onChange,
  active,
  revision,
}: {
  parentSessionId: string;
  childSessionId: string;
  ancestors: string[];
  onChange: (id: string, turn: SubagentObservationValue) => void;
  active: boolean;
  revision: number;
}) {
  const activeRef = useRef(active);
  const wake = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    activeRef.current = active;
    wake.current?.();
  }, [active]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let afterSeq = -1;
    let latest: ReturnType<typeof subagentTurnEvent>;
    let messages: Message[] = [];
    let truncated = false;
    let reading = false;
    let retryAttribution = false;
    const projection = createSubagentConversationProjection(childSessionId);
    onChange(childSessionId, null);
    const read = async (required = false) => {
      if (disposed || reading) return;
      if (
        !required &&
        !retryAttribution &&
        !activeRef.current &&
        latest?.status &&
        latest.status !== 'running'
      ) {
        timer = setTimeout(() => void read(), 5000);
        return;
      }
      reading = true;
      let hasMore = false;
      try {
        const page = await readSubagentConversation(
          parentSessionId,
          childSessionId,
          afterSeq,
          ancestors
        );
        if (disposed) return;
        if (afterSeq === -1) retryAttribution = false;
        retryAttribution ||= page.attributionUnavailable === true;
        afterSeq = page.throughSeq;
        if (page.events.length) messages = projection.append(page.events);
        truncated ||= page.events.some((event) => event.truncated);
        for (const event of page.events) latest = subagentTurnEvent(event) ?? latest;
        hasMore = page.hasMore;
        // Publish only the tail of a complete native read, not an old start in
        // the first page. These are display facts, never execution control.
        if (!hasMore) {
          onChange(childSessionId, { turn: latest, messages, truncated });
          // Optional root-history failure must not hide readable child content
          // or permanently lose file statistics. Retry on the normal interval.
          if (retryAttribution) afterSeq = -1;
        }
      } catch (error) {
        if (!disposed)
          onChange(childSessionId, { turn: undefined, messages, truncated, error: String(error) });
      } finally {
        reading = false;
        if (!disposed)
          timer = setTimeout(
            () => void read(hasMore),
            hasMore ? 0 : latest?.status === 'running' ? 1500 : 5000
          );
      }
    };
    wake.current = () => {
      clearTimeout(timer);
      void read(true);
    };
    void read(true);
    return () => {
      disposed = true;
      wake.current = undefined;
      clearTimeout(timer);
    };
  }, [parentSessionId, childSessionId, ancestors, onChange, revision]);
  return null;
}

function SubagentActivity({ turn }: { turn: SubagentTurn }) {
  const intl = useIntl();
  const [now, setNow] = useState(Date.now);
  const endedAt = turn?.endedAt;
  useEffect(() => {
    if (!endedAt) return;
    // Relative labels must keep ticking without republishing unchanged history
    // to the main conversation. This clock belongs only to the visible row.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [endedAt]);
  const label = intl.formatMessage(
    {
      id: 'workspaceSubagent.status',
      defaultMessage:
        '{state, select, running {Turn record still open} completed {Turn ended} failed {Turn failed} interrupted {Turn interrupted} limited {Output limit reached} blocked {Turn blocked} other {Status not yet available}}',
    },
    { state: turn?.status ?? 'unknown' }
  );
  if (turn?.status === 'running')
    return (
      <LoaderCircle
        className="size-3.5 shrink-0 animate-spin text-text-secondary"
        role="status"
        aria-label={label}
      />
    );
  if (!turn?.endedAt) return null;
  const elapsed = Math.max(0, now - turn.endedAt);
  const unit =
    elapsed < 60_000
      ? 'second'
      : elapsed < 3_600_000
        ? 'minute'
        : elapsed < 86_400_000
          ? 'hour'
          : 'day';
  const divisor =
    unit === 'second'
      ? 1000
      : unit === 'minute'
        ? 60_000
        : unit === 'hour'
          ? 3_600_000
          : 86_400_000;
  return (
    <time
      className="shrink-0 pr-1 text-[11px] text-text-secondary"
      dateTime={new Date(turn.endedAt).toISOString()}
      title={`${label} · ${intl.formatDate(turn.endedAt, { dateStyle: 'medium', timeStyle: 'short' })}`}
    >
      {intl.formatRelativeTime(-Math.floor(elapsed / divisor), unit, { numeric: 'always' })}
    </time>
  );
}

function CatalogRow({
  parentSessionId,
  ancestors,
  entry,
  turn,
}: {
  parentSessionId: string;
  ancestors: string[];
  entry: SubagentCatalogEntry;
  turn: SubagentTurn;
}) {
  const intl = useIntl();
  const local = entry.mode === 'one-shot' || entry.mode === 'continuable';
  const title = formatSubagentLabel(intl, entry.label?.trim() || entry.id);
  return (
    <li>
      <div className="flex min-w-0 items-center gap-1 px-2 py-1">
        {local ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-left hover:bg-background-secondary"
            title={title}
            onClick={() =>
              openSubagentConversation({
                parentSessionId,
                childSessionId: entry.id,
                ancestorSessionIds: ancestors,
                title,
              })
            }
          >
            <SubagentAvatar sessionId={entry.id} />
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
        ) : (
          <div
            className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-text-secondary"
            title={title}
          >
            <SubagentAvatar sessionId={entry.id} />
            <div className="min-w-0">
              <div className="truncate">{title}</div>
              <div className="text-xs">
                {intl.formatMessage(
                  entry.mode === 'external' ? subagentsMessages.external : subagentsMessages.unknown
                )}
              </div>
            </div>
          </div>
        )}
        {local && <SubagentActivity turn={turn} />}
      </div>
    </li>
  );
}

interface SubagentCatalogSnapshot {
  parentSessionId: string;
  children?: SubagentCatalogEntry[];
  turns: Record<string, SubagentObservationValue>;
  error: string;
  refresh: () => void;
  enabled: boolean;
}

const SubagentCatalogContext = createContext<SubagentCatalogSnapshot | undefined>(undefined);

export function useConversationChangeMessages(sessionId: string | undefined, messages: Message[]) {
  const cache = useContext(SubagentCatalogContext);
  return useMemo(() => {
    if (!cache?.enabled || cache.parentSessionId !== sessionId || !cache.children) return messages;
    return conversationChangeMessages(
      messages,
      cache.children.flatMap((entry) => {
        const snapshot = cache.turns[entry.id];
        return snapshot && ['one-shot', 'continuable'].includes(entry.mode)
          ? [{ id: entry.id, messages: snapshot.messages }]
          : [];
      })
    );
  }, [cache, sessionId, messages]);
}

export function usePreloadedSubagentConversation(
  parentSessionId: string,
  childSessionId: string,
  ancestors?: readonly string[]
) {
  const cache = useContext(SubagentCatalogContext);
  if (!cache?.enabled || cache.parentSessionId !== parentSessionId || ancestors?.length) return;
  if (!cache.children && cache.error)
    return {
      snapshot: { turn: undefined, messages: [], truncated: false, error: cache.error },
      refresh: cache.refresh,
    };
  if (
    cache.children &&
    !cache.children.some(
      (entry) => entry.id === childSessionId && ['one-shot', 'continuable'].includes(entry.mode)
    )
  )
    return;
  return { snapshot: cache.turns[childSessionId] ?? null, refresh: cache.refresh };
}

interface SubagentCatalogProviderProps {
  parentSessionId: string;
  cacheKey?: string;
  enabled?: boolean;
  active?: boolean;
  children: ReactNode;
}

export function SubagentCatalogProvider({
  children,
  cacheKey,
  ...props
}: SubagentCatalogProviderProps) {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === props.parentSessionId)
        setEpoch((value) => value + 1);
    };
    window.addEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, changed);
    return () => window.removeEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, changed);
  }, [props.parentSessionId]);
  const identity = JSON.stringify([cacheKey ?? props.parentSessionId, epoch]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [published, setPublished] = useState<{
    identity: string;
    snapshot: SubagentCatalogSnapshot;
  }>();
  const publish = useCallback(
    (snapshot: SubagentCatalogSnapshot) => {
      if (currentIdentity.current === identity) setPublished({ identity, snapshot });
    },
    [identity]
  );
  const snapshot =
    published?.identity === identity &&
    published.snapshot.enabled === (props.enabled !== false) &&
    props.enabled !== false
      ? published.snapshot
      : {
          parentSessionId: props.parentSessionId,
          turns: {},
          error: '',
          refresh: () => {},
          enabled: props.enabled !== false,
        };
  // Only the readonly loader remounts. Main chats keep their SSE connections and
  // local state when switching the current conversation or workspace binding.
  return (
    <SubagentCatalogContext.Provider value={snapshot}>
      <SubagentCatalogCache key={identity} {...props} onChange={publish} />
      {children}
    </SubagentCatalogContext.Provider>
  );
}

// One readonly display cache per mounted main conversation. It starts after the
// main session is available and survives opening/closing the sidebar.
function SubagentCatalogCache({
  parentSessionId,
  enabled = true,
  active = true,
  onChange,
}: Omit<SubagentCatalogProviderProps, 'children' | 'cacheKey'> & {
  onChange: (snapshot: SubagentCatalogSnapshot) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [children, setChildren] = useState<SubagentCatalogEntry[]>();
  const [turns, setTurns] = useState<Record<string, SubagentObservationValue>>({});
  const onTurn = useCallback((id: string, turn: SubagentObservationValue) => {
    setTurns((previous) => {
      const current = previous[id];
      if (
        current === turn ||
        (current &&
          turn &&
          current.messages === turn.messages &&
          current.turn?.status === turn.turn?.status &&
          current.turn?.endedAt === turn.turn?.endedAt &&
          current.truncated === turn.truncated &&
          current.error === turn.error)
      )
        return previous;
      return { ...previous, [id]: turn };
    });
  }, []);
  const [error, setError] = useState('');
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    onChange({ parentSessionId, children, turns, error, refresh, enabled });
  }, [onChange, parentSessionId, children, turns, error, refresh, enabled]);
  useEffect(() => {
    if (!enabled || !parentSessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const page = await readSubagentCatalog(parentSessionId, ROOT_PATH);
        if (disposed) return;
        setChildren((previous) =>
          previous?.length === page.children.length &&
          previous.every((entry, index) => {
            const next = page.children[index];
            return (
              entry.id === next.id &&
              entry.createdAt === next.createdAt &&
              entry.mode === next.mode &&
              entry.label === next.label
            );
          })
            ? previous
            : page.children
        );
        setError('');
        // Discovery and cold inspection never activate agents.
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        if (!disposed && active) timer = setTimeout(() => void read(), 5000);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [parentSessionId, enabled, active, revision]);
  return (
    <>
      {enabled &&
        children
          ?.filter((entry) => entry.mode === 'continuable' || entry.mode === 'one-shot')
          .map((entry) => (
            <SubagentObservation
              key={entry.id}
              parentSessionId={parentSessionId}
              childSessionId={entry.id}
              ancestors={ROOT_PATH}
              onChange={onTurn}
              active={active}
              revision={revision}
            />
          ))}
    </>
  );
}

function CatalogBranch({ children, turns, error, parentSessionId }: SubagentCatalogSnapshot) {
  const intl = useIntl();
  const pending = (entry: SubagentCatalogEntry) =>
    (entry.mode === 'continuable' || entry.mode === 'one-shot') &&
    (!Object.prototype.hasOwnProperty.call(turns, entry.id) || turns[entry.id] === null);
  const hasPendingTurns = children?.some(pending) ?? false;
  return (
    <>
      {error && (
        <div role="alert" className="px-3 py-2 text-xs text-red-600">
          {children && <p>{intl.formatMessage(subagentsMessages.stale)}</p>}
          <p>{error}</p>
        </div>
      )}
      {((!children && !error) || hasPendingTurns) && (
        <p role="status" className="p-3 text-xs text-text-secondary">
          {intl.formatMessage(subagentsMessages.loading)}
        </p>
      )}
      {children?.length === 0 && (
        <p className="p-3 text-xs text-text-secondary">
          {intl.formatMessage(subagentsMessages.empty)}
        </p>
      )}
      {!!children?.length &&
        (['running', 'ended', 'unknownState'] as const).map((group) => {
          const entries = children.filter((entry) => {
            if (pending(entry)) return false;
            const status = turns[entry.id]?.turn?.status;
            return group === 'running'
              ? status === 'running'
              : group === 'ended'
                ? !!status && status !== 'running'
                : !status;
          });
          if (!entries.length && (group !== 'running' || hasPendingTurns)) return null;
          return (
            <section
              key={group}
              aria-label={intl.formatMessage(subagentsMessages[group], { count: entries.length })}
            >
              <h3 className="px-3 pb-2 pt-5 text-xs font-normal text-text-secondary">
                {intl.formatMessage(subagentsMessages[group], { count: entries.length })}
              </h3>
              {group === 'running' && !entries.length && (
                <p className="px-3 pb-2 text-xs text-text-secondary">
                  {intl.formatMessage(subagentsMessages.noRunning)}
                </p>
              )}
              <ul>
                {entries.map((entry) => (
                  <CatalogRow
                    key={entry.id}
                    parentSessionId={parentSessionId}
                    ancestors={ROOT_PATH}
                    entry={entry}
                    turn={turns[entry.id]?.turn}
                  />
                ))}
              </ul>
            </section>
          );
        })}
    </>
  );
}

export function WorkspaceSubagents({
  parentSessionId,
  loadOnDemand = false,
}: {
  parentSessionId: string;
  loadOnDemand?: boolean;
}) {
  const snapshot = useContext(SubagentCatalogContext);
  if (!snapshot || snapshot.parentSessionId !== parentSessionId || (loadOnDemand && !snapshot.enabled))
    return (
      <SubagentCatalogProvider key={parentSessionId} parentSessionId={parentSessionId}>
        <WorkspaceSubagents parentSessionId={parentSessionId} />
      </SubagentCatalogProvider>
    );
  return <SubagentCatalogView snapshot={snapshot} />;
}

function SubagentCatalogView({ snapshot }: { snapshot: SubagentCatalogSnapshot }) {
  const intl = useIntl();
  return (
    <section
      aria-label={intl.formatMessage(subagentsMessages.title)}
      className="flex min-h-0 flex-1 flex-col text-[13px]"
    >
      <header className="flex items-center justify-between border-b border-border-primary px-3 py-2">
        <span>{intl.formatMessage(subagentsMessages.title)}</span>
        <button
          type="button"
          className="wb-icon"
          aria-label={intl.formatMessage(subagentsMessages.refresh)}
          onClick={snapshot.refresh}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <CatalogBranch {...snapshot} />
      </div>
    </section>
  );
}
