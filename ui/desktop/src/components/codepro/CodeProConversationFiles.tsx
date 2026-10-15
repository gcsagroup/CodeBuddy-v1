import { useMemo, useState } from 'react';
import { FileCode2, ChevronRight } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { getToolRequests, getToolResponses, type Message } from '../../types/message';
import { parseToolAuditReceipt } from '../../acp/adapter/toolAudit';
import { presentedToolCall } from './CodeProToolContent';
import { CodeProFileViewer } from './CodeProFileViewer';
import { fileChangeReceipt, FileChangeCount } from './CodeProFileChange';
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
});

function fileIdentity(path: string, workspaceRoot?: string) {
  let normalized = path.replace(/\\/g, '/');
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) && workspaceRoot)
    normalized = `${workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${normalized.replace(/^\.\//, '')}`;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

// A view of successful local write receipts, never a scan of the worktree or
// an inference from the model's final answer. Shell-only changes stay in their receipts.
export function CodeProConversationFiles({
  messages,
  workspaceRoot,
}: {
  messages: Message[];
  workspaceRoot?: string;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const changes = useMemo(() => {
    const requests = new Map(
      messages.flatMap(getToolRequests).map((request) => [request.id, request])
    );
    return messages.flatMap(getToolResponses).flatMap((response) => {
      const change = fileChangeReceipt(response, requests.get(response.id));
      return change ? [{ id: response.id, change }] : [];
    });
  }, [messages]);
  const files = useMemo(() => {
    const responses = new Map(
      messages.flatMap((message) =>
        getToolResponses(message).map((response) => [response.id, response] as const)
      )
    );
    const paths = new Map<string, string>();
    for (const { change } of changes)
      paths.set(fileIdentity(change.path, workspaceRoot), change.path);
    for (const message of messages) {
      for (const request of getToolRequests(message)) {
        const call = presentedToolCall(request);
        const response = responses.get(request.id);
        const audit = parseToolAuditReceipt(response?.metadata?.toolAudit);
        if (!call) continue;
        const result = response?.toolResult;
        const nativeReceipt =
          request.metadata?.extensionName === 'harness' &&
          result?.status === 'success' &&
          result.value &&
          typeof result.value === 'object' &&
          (result.value as Record<string, unknown>).isError !== true;
        if (
          !nativeReceipt &&
          (!audit ||
            audit.outcome !== 'success' ||
            !['platform', 'builtin'].includes(audit.extensionSource))
        )
          continue;
        const name = call.name.split(/__|::/).pop();
        const write =
          name === 'write' ||
          name === 'edit' ||
          (name === 'text_editor' &&
            ['write', 'str_replace', 'insert'].includes(String(call.arguments.command)));
        const path = call.arguments.file_path ?? call.arguments.path;
        if (write && typeof path === 'string') {
          const identity = fileIdentity(path, workspaceRoot);
          if (!paths.has(identity)) paths.set(identity, path);
        }
      }
    }
    return [...paths.values()];
  }, [messages, changes, workspaceRoot]);
  if (!files.length) return null;
  const totals = changes.reduce(
    (total, { change }) => ({
      added: total.added + change.added,
      removed: total.removed + change.removed,
    }),
    { added: 0, removed: 0 }
  );
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="my-4 overflow-hidden rounded-xl border border-border-subtle"
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-3 px-3 py-3 text-left text-text-primary"
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
          {changes.length > 0 && (
            <span className="mt-0.5 block" title={intl.formatMessage(i18n.counts)}>
              <FileChangeCount change={totals} />
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="codepro-disclosure-content">
        <div className="border-t border-border-subtle py-1">
          <CodeProFileViewer
            files={showAll ? files : files.slice(0, 3)}
            workspaceRoot={workspaceRoot}
            changesForFile={(path) =>
              changes
                .filter(
                  ({ change }) =>
                    fileIdentity(change.path, workspaceRoot) === fileIdentity(path, workspaceRoot)
                )
                .map(({ change }) => change)
            }
          />
          {!showAll && files.length > 3 && (
            <button
              type="button"
              className="px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
              onClick={() => setShowAll(true)}
            >
              {intl.formatMessage(i18n.moreFiles, { count: files.length - 3 })}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
