import { useMemo, useState } from 'react';
import { FileCode2, ChevronRight } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { getToolResponses, type Message } from '../../types/message';
import { openConversationChange } from '../../workspace-panel/conversationChangePanel';
import {
  collectConversationChanges,
  displayChangePath,
  type ConversationChangeTurn,
} from './conversationChanges';
import { FileChangeCount } from './CodeProFileChange';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

const i18n = defineMessages({
  files: {
    id: 'conversationFiles.files',
    defaultMessage: 'Modified {count} files this turn',
  },
  counts: {
    id: 'conversationFiles.changes',
    defaultMessage: 'Changes per operation (not a net workspace diff)',
  },
  moreFiles: {
    id: 'conversationFiles.moreFiles',
    defaultMessage: 'Show {count} more files',
  },
  viewChanges: { id: 'conversationFiles.viewChanges', defaultMessage: 'View changes' },
  diffUnavailable: {
    id: 'conversationFiles.diffUnavailable',
    defaultMessage: 'Historical diff unavailable for some operations',
  },
});

// The card opens saved evidence in the workbench. It never reads today's files
// or expands a second history viewer inside the conversation.
export function CodeProConversationFiles({
  messages,
  sourceMessages,
  sourceChanges,
  workspaceRoot,
  sessionId,
}: {
  messages: Message[];
  sourceMessages?: Message[];
  sourceChanges?: ConversationChangeTurn[];
  workspaceRoot?: string;
  sessionId?: string;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const source = messages.find(
    (message) =>
      message.role === 'user' &&
      message.metadata.userVisible &&
      getToolResponses(message).length === 0
  );
  const turn = useMemo(
    () =>
      source?.id && (sourceChanges || sourceMessages)
        ? (sourceChanges ?? collectConversationChanges(sourceMessages!, workspaceRoot)).find(
            (entry) => entry.id === source.id
          )
        : collectConversationChanges(messages, workspaceRoot)[0],
    [messages, sourceMessages, sourceChanges, source?.id, workspaceRoot]
  );
  if (!turn) return null;
  const open = (filePath?: string) => {
    if (sessionId)
      openConversationChange({
        sessionId,
        turnId: source?.id ?? undefined,
        ...(filePath ? { filePath } : {}),
      });
  };
  const { files } = turn;
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="my-4 overflow-hidden rounded-xl border border-border-subtle"
    >
      <div className="flex items-center pr-3">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left text-text-primary"
          aria-label={intl.formatMessage(i18n.files, { count: files.length })}
        >
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background-secondary"
            aria-hidden="true"
          >
            <FileCode2 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-semibold">
              {intl.formatMessage(i18n.files, { count: files.length })}
              <ChevronRight
                className={`h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
                aria-hidden="true"
              />
            </span>
            {files.some((file) => file.changes.length > 0) && (
              <span className="mt-0.5 block" title={intl.formatMessage(i18n.counts)}>
                <FileChangeCount change={turn} />
              </span>
            )}
          </span>
        </CollapsibleTrigger>
        {sessionId && (
          <button
            type="button"
            className="shrink-0 text-xs text-text-secondary hover:text-text-primary"
            onClick={() => open()}
          >
            {intl.formatMessage(i18n.viewChanges)}
          </button>
        )}
      </div>
      <CollapsibleContent className="codepro-disclosure-content">
        <ul className="border-t border-border-subtle py-1">
          {(showAll ? files : files.slice(0, 3)).map((file) => {
            const content = (
              <>
                <FileCode2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {displayChangePath(file.path, workspaceRoot)}
                </span>
                {file.changes.length > 0 && <FileChangeCount change={file} />}
              </>
            );
            return (
              <li key={file.key}>
                {sessionId ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-text-secondary hover:text-text-primary"
                    aria-label={file.path}
                    onClick={() => open(file.path)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 px-3 py-2 text-sm text-text-secondary">
                    {content}
                  </div>
                )}
                {file.hasUnavailableDiff && (
                  <p className="px-3 pb-2 text-xs text-text-secondary">
                    {intl.formatMessage(i18n.diffUnavailable)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {!showAll && files.length > 3 && (
          <button
            type="button"
            className="px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
            onClick={() => setShowAll(true)}
          >
            {intl.formatMessage(i18n.moreFiles, { count: files.length - 3 })}
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
