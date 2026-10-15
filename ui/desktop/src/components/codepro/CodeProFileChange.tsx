import { structuredPatch } from 'diff';
import type { ToolRequestMessageContent, ToolResponseMessageContent } from '../../types/message';
import { parseToolAuditReceipt } from '../../acp/adapter/toolAudit';

export interface FileChangeReceipt {
  path: string;
  added: number;
  removed: number;
  diff: string;
  diff_truncated: boolean;
}

export function fileChangeReceipt(
  response?: ToolResponseMessageContent,
  request?: ToolRequestMessageContent
): FileChangeReceipt | undefined {
  const audit = parseToolAuditReceipt(response?.metadata?.toolAudit);
  const result = response?.toolResult;
  if (result?.status !== 'success' || !result.value || typeof result.value !== 'object') return;
  const receipt = result.value as Record<string, unknown>;
  if (receipt.isError === true) return;
  const raw = receipt.structuredContent ?? response?.metadata?.rawOutput;
  if (!raw || typeof raw !== 'object') return;
  const call = request?.toolCall.status === 'success' ? request.toolCall.value : request?.toolCall;
  if (
    request?.metadata?.extensionName === 'harness' &&
    call &&
    typeof call === 'object' &&
    'name' in call &&
    ['write', 'edit'].includes(String(call.name))
  ) {
    return nativeFileChange(raw as Record<string, unknown>);
  }
  if (
    !audit ||
    audit.outcome !== 'success' ||
    !['platform', 'builtin'].includes(audit.extensionSource)
  )
    return;
  const change = (raw as Record<string, unknown>).file_change;
  if (!change || typeof change !== 'object') return;
  const entry = change as Record<string, unknown>;
  if (
    entry.schema_version !== 1 ||
    typeof entry.path !== 'string' ||
    typeof entry.added !== 'number' ||
    !Number.isSafeInteger(entry.added) ||
    entry.added < 0 ||
    typeof entry.removed !== 'number' ||
    !Number.isSafeInteger(entry.removed) ||
    entry.removed < 0 ||
    typeof entry.diff !== 'string' ||
    typeof entry.diff_truncated !== 'boolean'
  )
    return;
  return entry as unknown as FileChangeReceipt;
}

const nativeChanges = new WeakMap<object, FileChangeReceipt | undefined>();
function nativeFileChange(raw: Record<string, unknown>): FileChangeReceipt | undefined {
  if (nativeChanges.has(raw)) return nativeChanges.get(raw);
  nativeChanges.set(raw, undefined);
  // A missing basis on an update can mean an existing large file. Only an
  // explicit create receipt permits treating the previous file as empty.
  const before = raw.before === null && raw.operation === 'create' ? '' : raw.before;
  if (
    typeof raw.path !== 'string' ||
    typeof before !== 'string' ||
    typeof raw.after !== 'string' ||
    before.length + raw.after.length > 1_000_000
  )
    return;
  const patch = structuredPatch(raw.path, raw.path, before, raw.after, '', '', {
    context: 3,
    timeout: 40,
    maxEditLength: 20_000,
  });
  if (!patch) return;
  const lines = patch.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);
  const change: FileChangeReceipt = {
    path: raw.path,
    added: patch.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('+')).length,
      0
    ),
    removed: patch.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-')).length,
      0
    ),
    diff: lines.slice(0, 400).join('\n'),
    diff_truncated: lines.length > 400,
  };
  nativeChanges.set(raw, change);
  return change;
}

export function FileChangeCount({
  change,
}: {
  change: Pick<FileChangeReceipt, 'added' | 'removed'>;
}) {
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-green-700 dark:text-green-400">+{change.added}</span>
      <span className="text-red-600 dark:text-red-400">−{change.removed}</span>
    </span>
  );
}

export function FileChangeDiff({ change }: { change: FileChangeReceipt }) {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const lines = change.diff.split('\n').map((text) => {
    // Unified diff headers carry real file positions, including separate hunks.
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, kind: 'meta', number: undefined };
    }
    if (oldLine !== undefined && newLine !== undefined) {
      if (text.startsWith('-')) return { text, kind: 'removed', number: oldLine++ };
      if (text.startsWith('+')) return { text, kind: 'added', number: newLine++ };
      if (text.startsWith(' ')) {
        oldLine++;
        return { text, kind: 'context', number: newLine++ };
      }
    }
    return { text, kind: 'meta', number: undefined };
  });
  return (
    <pre className="overflow-auto whitespace-pre font-mono text-xs leading-5 text-text-primary">
      <code className="block min-w-max">
        {lines.map((line, index) => (
          <span
            key={index}
            data-diff-kind={line.kind}
            className={
              line.kind === 'added'
                ? 'flex bg-green-100/70 dark:bg-green-900/30'
                : line.kind === 'removed'
                  ? 'flex bg-red-100/70 dark:bg-red-900/30'
                  : 'flex'
            }
          >
            <span
              className="min-w-[4ch] shrink-0 select-none pr-3 text-right opacity-60"
              aria-hidden="true"
            >
              {line.number ?? ' '}
            </span>
            <span className="pr-2">{line.text || ' '}</span>
          </span>
        ))}
        {change.diff_truncated && <span>…</span>}
      </code>
    </pre>
  );
}
