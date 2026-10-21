import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { readSubagentCatalog, type SubagentCatalogEntry } from '../acp/subagentCatalog';
import { openSubagentConversation } from './subagentPanel';
import { SubagentAvatar } from '../components/SubagentAvatar';

export const subagentsMessages = defineMessages({
  title: { id: 'workspaceSubagents.title', defaultMessage: 'Subagents' },
  refresh: { id: 'workspaceSubagents.refresh', defaultMessage: 'Refresh subagents' },
  loading: { id: 'workspaceSubagents.loading', defaultMessage: 'Loading subagents…' },
  empty: { id: 'workspaceSubagents.empty', defaultMessage: 'No subagents in this directory.' },
  children: { id: 'workspaceSubagents.children', defaultMessage: 'Children of {name}' },
  external: { id: 'workspaceSubagents.external', defaultMessage: 'External agent' },
  unknown: { id: 'workspaceSubagents.unknown', defaultMessage: 'Conversation unavailable' },
  hint: {
    id: 'workspaceSubagents.hint',
    defaultMessage:
      'Select an agent to read its conversation. Expand an arrow to browse its children.',
  },
  stale: {
    id: 'workspaceSubagents.stale',
    defaultMessage:
      'The directory could not be refreshed. Previously loaded entries are shown below.',
  },
});

const ROOT_PATH: string[] = [];

function CatalogRow({
  parentSessionId,
  ancestors,
  entry,
  revision,
}: {
  parentSessionId: string;
  ancestors: string[];
  entry: SubagentCatalogEntry;
  revision: number;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const path = useMemo(() => [...ancestors, entry.id], [ancestors, entry.id]);
  const local = entry.mode === 'one-shot' || entry.mode === 'continuable';
  const title = entry.label?.trim() || entry.id;
  return (
    <li>
      <div className="flex min-w-0 items-center gap-1 px-2 py-1">
        {local && ancestors.length < 32 ? (
          <button
            type="button"
            className="wb-icon shrink-0"
            aria-label={intl.formatMessage(subagentsMessages.children, { name: title })}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight size={14} className={expanded ? 'rotate-90' : ''} />
          </button>
        ) : (
          <span className="w-7 shrink-0" />
        )}
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
        <time
          className="shrink-0 pr-1 text-[11px] text-text-secondary"
          dateTime={new Date(entry.createdAt).toISOString()}
          title={intl.formatDate(entry.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
        >
          {intl.formatDate(entry.createdAt, { month: 'numeric', day: 'numeric' })}
        </time>
      </div>
      {expanded && local && (
        <div className="ml-5 border-l border-border-subtle">
          <CatalogBranch parentSessionId={parentSessionId} ancestors={path} revision={revision} />
        </div>
      )}
    </li>
  );
}

function CatalogBranch({
  parentSessionId,
  ancestors,
  revision,
}: {
  parentSessionId: string;
  ancestors: string[];
  revision: number;
}) {
  const intl = useIntl();
  const [children, setChildren] = useState<SubagentCatalogEntry[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const page = await readSubagentCatalog(parentSessionId, ancestors);
        if (disposed) return;
        setChildren(page.children);
        setError('');
        // Only this visible directory and expanded branches are mounted.
        // Catalog discovery does not activate agents or infer their task state.
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 5000);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [parentSessionId, ancestors, revision]);
  return (
    <>
      {error && (
        <div role="alert" className="px-3 py-2 text-xs text-red-600">
          {children && <p>{intl.formatMessage(subagentsMessages.stale)}</p>}
          <p>{error}</p>
        </div>
      )}
      {!children && !error && (
        <p role="status" className="p-3 text-xs text-text-secondary">
          {intl.formatMessage(subagentsMessages.loading)}
        </p>
      )}
      {children?.length === 0 && (
        <p className="p-3 text-xs text-text-secondary">
          {intl.formatMessage(subagentsMessages.empty)}
        </p>
      )}
      {!!children?.length && (
        <ul>
          {children.map((entry) => (
            <CatalogRow
              key={entry.id}
              parentSessionId={parentSessionId}
              ancestors={ancestors}
              entry={entry}
              revision={revision}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export function WorkspaceSubagents({ parentSessionId }: { parentSessionId: string }) {
  const intl = useIntl();
  const [revision, refresh] = useState(0);
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
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <p className="px-3 py-2 text-xs leading-5 text-text-secondary">
          {intl.formatMessage(subagentsMessages.hint)}
        </p>
        <CatalogBranch
          key={parentSessionId}
          parentSessionId={parentSessionId}
          ancestors={ROOT_PATH}
          revision={revision}
        />
      </div>
    </section>
  );
}
