import { useMemo, useState } from 'react';
import { ArrowLeft, FileDiff } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { Message } from '../types/message';
import {
  collectConversationChanges,
  displayChangePath,
  fileIdentity,
  conversationFileOperation,
} from '../components/codepro/conversationChanges';
import { FileChangeCount, FileChangeDiff } from '../components/codepro/CodeProFileChange';
import { openConversationChange } from './conversationChangePanel';
import { openWorkspaceFile } from './workspaceFilePanel';
import { useConversationChangeMessages } from './WorkspaceSubagents';

export const changeMessages = defineMessages({
  title: { id: 'workspaceChanges.title', defaultMessage: 'Changes' },
  turn: { id: 'workspaceChanges.turn', defaultMessage: 'Turn {number}' },
  unassigned: { id: 'workspaceChanges.unassigned', defaultMessage: 'Earlier records' },
  all: { id: 'workspaceChanges.all', defaultMessage: 'All turns' },
  total: {
    id: 'workspaceChanges.total',
    defaultMessage: '{files} files across {turns} turns',
  },
  coverage: {
    id: 'workspaceChanges.coverage',
    defaultMessage:
      'Totals count recorded file edits. Command, external tool and child-agent edits may not be included.',
  },
  empty: { id: 'workspaceChanges.empty', defaultMessage: 'No recorded file changes yet.' },
  unavailable: {
    id: 'workspaceChanges.unavailable',
    defaultMessage: 'A file modification was recorded, but its historical diff is unavailable.',
  },
  operationUnavailable: {
    id: 'workspaceChanges.operationUnavailable',
    defaultMessage: 'No historical diff was returned for this operation.',
  },
  missing: {
    id: 'workspaceChanges.missing',
    defaultMessage: 'This change is no longer present in the conversation records.',
  },
  operation: { id: 'workspaceChanges.operation', defaultMessage: 'Edit {number}' },
  truncated: {
    id: 'workspaceChanges.truncated',
    defaultMessage: 'This long diff has been shortened.',
  },
  partial: {
    id: 'workspaceChanges.partial',
    defaultMessage: 'Some recorded edits have no historical diff. Line totals are partial.',
  },
});

export function WorkspaceChanges({
  sessionId,
  workspaceRoot,
  messages,
  selection,
}: {
  sessionId: string;
  workspaceRoot?: string;
  messages: Message[];
  selection?: { turnId?: string; filePath: string; toolCallId?: string };
}) {
  const intl = useIntl();
  const changeSource = useConversationChangeMessages(sessionId, messages);
  const turns = useMemo(
    () => collectConversationChanges(changeSource, workspaceRoot),
    [changeSource, workspaceRoot]
  );
  const [filter, setFilter] = useState('all');
  const label = (number: number) =>
    intl.formatMessage(number ? changeMessages.turn : changeMessages.unassigned, { number });
  const turn = selection && turns.find((item) => item.id === selection.turnId);
  const operation = selection?.toolCallId
    ? conversationFileOperation(changeSource, selection.toolCallId)
    : undefined;
  const file = selection?.toolCallId
    ? operation?.kind === 'change' &&
      fileIdentity(operation.path, workspaceRoot) ===
        fileIdentity(selection.filePath, workspaceRoot)
      ? {
          changes: operation.change ? [operation.change] : [],
          added: operation.change?.added ?? 0,
          removed: operation.change?.removed ?? 0,
          hasUnavailableDiff: !operation.change,
        }
      : undefined
    : turn &&
      turn.files.find((item) => item.key === fileIdentity(selection!.filePath, workspaceRoot));
  const totals = turns.reduce(
    (sum, item) => ({ added: sum.added + item.added, removed: sum.removed + item.removed }),
    { added: 0, removed: 0 }
  );
  const fileCount = new Set(turns.flatMap((item) => item.files.map((entry) => entry.key))).size;
  const hasKnownChanges = turns.some((item) =>
    item.files.some((entry) => entry.changes.length > 0)
  );
  const hasMissingDiff = turns.some((item) => item.files.some((entry) => entry.hasUnavailableDiff));
  return (
    <section
      aria-label={intl.formatMessage(changeMessages.title)}
      className="min-h-0 flex-1 overflow-auto text-[13px]"
    >
      {selection ? (
        <>
          <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-primary bg-background-primary px-3 py-2">
            <button
              type="button"
              className="wb-icon"
              aria-label={intl.formatMessage(changeMessages.all)}
              onClick={() => openConversationChange({ sessionId })}
            >
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate" title={selection.filePath}>
                {displayChangePath(selection.filePath, workspaceRoot)}
              </div>
              {turn && <div className="text-xs text-text-secondary">{label(turn.number)}</div>}
            </div>
            {!!file?.changes.length && <FileChangeCount change={file} />}
          </header>
          {!file ? (
            <p className="p-3 text-text-secondary">{intl.formatMessage(changeMessages.missing)}</p>
          ) : (
            <div className="space-y-3 py-3">
              {file.hasUnavailableDiff && (
                <p className="px-3 text-text-secondary">
                  {intl.formatMessage(
                    selection.toolCallId
                      ? changeMessages.operationUnavailable
                      : changeMessages.unavailable
                  )}
                </p>
              )}
              {file.changes.map((change, index) => (
                <div key={index}>
                  {file.changes.length > 1 && (
                    <div className="flex items-center gap-2 px-3 py-1 text-xs text-text-secondary">
                      {intl.formatMessage(changeMessages.operation, { number: index + 1 })}
                      <FileChangeCount change={change} />
                    </div>
                  )}
                  <FileChangeDiff change={change} />
                  {change.diff_truncated && (
                    <p className="px-3 text-xs text-text-secondary">
                      {intl.formatMessage(changeMessages.truncated)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <header className="space-y-2 border-b border-border-primary p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {intl.formatMessage(changeMessages.total, {
                  files: fileCount,
                  turns: turns.length,
                })}
              </span>
              {hasKnownChanges && <FileChangeCount change={totals} />}
            </div>
            <select
              className="max-w-full rounded-md border border-border-primary bg-background-primary px-2 py-1"
              aria-label={intl.formatMessage(changeMessages.title)}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">{intl.formatMessage(changeMessages.all)}</option>
              {[...turns].reverse().map((item) => (
                <option key={item.id} value={item.id}>
                  {label(item.number)}
                </option>
              ))}
            </select>
            <p className="text-xs leading-5 text-text-secondary">
              {intl.formatMessage(changeMessages.coverage)}
            </p>
            {hasMissingDiff && (
              <p className="text-xs leading-5 text-text-secondary">
                {intl.formatMessage(changeMessages.partial)}
              </p>
            )}
          </header>
          {!turns.length && (
            <p className="p-3 text-text-secondary">{intl.formatMessage(changeMessages.empty)}</p>
          )}
          {[...turns]
            .reverse()
            .filter((item) => filter === 'all' || filter === item.id)
            .map((item) => (
              <details key={item.id} open className="border-b border-border-subtle">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
                  <span className="shrink-0 font-medium">{label(item.number)}</span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.title}>
                    {item.title}
                  </span>
                  {item.files.some((entry) => entry.changes.length > 0) && (
                    <FileChangeCount change={item} />
                  )}
                </summary>
                <ul>
                  {item.files.map((entry) => (
                    <li key={entry.key}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-background-secondary"
                        title={entry.path}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openWorkspaceFile({
                            sessionId,
                            filePath: entry.path,
                            action: 'file-menu',
                          });
                        }}
                        onClick={() =>
                          openConversationChange({
                            sessionId,
                            turnId: item.id,
                            filePath: entry.path,
                          })
                        }
                      >
                        <FileDiff size={14} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {displayChangePath(entry.path, workspaceRoot)}
                        </span>
                        {entry.changes.length > 0 && <FileChangeCount change={entry} />}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
        </>
      )}
    </section>
  );
}
