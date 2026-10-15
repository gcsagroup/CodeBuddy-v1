import MarkdownContent from '../MarkdownContent';
import '../ui/disclosure.css';
import { fileChangeReceipt, FileChangeDiff } from './CodeProFileChange';
import type { ReactNode } from 'react';
import { Check, ChevronRight, Circle, ListChecks, LoaderCircle, Pause } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import type { ToolRequestMessageContent, ToolResponseMessageContent } from '../../types/message';

const messages = defineMessages({
  plan: { id: 'codeProToolContent.plan', defaultMessage: 'Work plan' },
  previousPlan: {
    id: 'codeProToolContent.previousPlan',
    defaultMessage: 'Earlier plan for this task',
  },
  previousPlanNotice: {
    id: 'codeProToolContent.previousPlanNotice',
    defaultMessage:
      'This plan belongs to an earlier task revision. It is shown for reference, not as current progress.',
  },
  inProgress: { id: 'codeProToolContent.inProgress', defaultMessage: 'In progress' },
  notRunning: { id: 'codeProToolContent.notRunning', defaultMessage: 'Not currently running' },
  proposed: {
    id: 'codeProToolContent.proposed',
    defaultMessage: 'Proposed content — execution not confirmed',
  },
  submitted: {
    id: 'codeProToolContent.submitted',
    defaultMessage: 'Content submitted for this operation',
  },
  before: { id: 'codeProToolContent.before', defaultMessage: 'Replace' },
  after: { id: 'codeProToolContent.after', defaultMessage: 'With' },
  output: { id: 'codeProToolContent.output', defaultMessage: 'Execution result' },
  exit: { id: 'codeProToolContent.exit', defaultMessage: 'Exit code: {code}' },
  timeout: {
    id: 'codeProToolContent.timeout',
    defaultMessage: 'Timed out — subsequent effects may need checking',
  },
});

export function isPlanTool(name: string): boolean {
  return name.split(/__|::/).pop() === 'todo_write';
}

export function isProgressTool(name: string): boolean {
  return name === 'codepro__publish_progress';
}

export function presentedToolCall(
  request: ToolRequestMessageContent
): { name: string; arguments: Record<string, unknown> } | undefined {
  const data = request.toolCall.status === 'success' ? request.toolCall.value : request.toolCall;
  if (!data || typeof data !== 'object') return undefined;
  const call = data as Record<string, unknown>;
  if (typeof call.name !== 'string') return undefined;
  return {
    name: call.name,
    arguments:
      call.arguments && typeof call.arguments === 'object'
        ? (call.arguments as Record<string, unknown>)
        : {},
  };
}

export function hasReadableToolContent(name: string): boolean {
  return ['shell', 'write', 'edit', 'read_document', 'todo_write'].includes(
    name.split(/__|::/).pop() ?? ''
  );
}

// This view consumes requests and receipts; submitted code is not a before/after
// workspace diff, and a checked plan item is not a completed run.
export function CodeProToolContent({
  name,
  args,
  response,
}: {
  name: string;
  args: Record<string, unknown>;
  response?: ToolResponseMessageContent;
}) {
  const intl = useIntl();
  const kind = name.split(/__|::/).pop();
  const change = fileChangeReceipt(response);
  const result = response?.toolResult;
  const value = result?.status === 'success' ? result.value : undefined;
  const receipt =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const confirmed =
    receipt !== undefined && receipt.isError !== true && Array.isArray(receipt.content);
  const rawStructured = receipt?.structuredContent ?? response?.metadata?.rawOutput;
  const structured =
    rawStructured && typeof rawStructured === 'object' && !Array.isArray(rawStructured)
      ? (rawStructured as Record<string, unknown>)
      : undefined;
  const blocks = Array.isArray(receipt?.content) ? receipt.content : [];
  const output =
    result?.status === 'error' && typeof result.error === 'string'
      ? result.error
      : blocks
          .flatMap((block: unknown) => {
            if (!block || typeof block !== 'object') return [];
            const item = block as Record<string, unknown>;
            const annotations = item.annotations as { audience?: string[] } | undefined;
            if (annotations?.audience && !annotations.audience.includes('user')) return [];
            return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
          })
          .join('\n');
  const code = (text: string) => (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{text}</pre>
  );

  return (
    <div className="space-y-3 py-2 text-sm text-text-primary" data-testid="readable-tool-content">
      {isPlanTool(name) && typeof args.content === 'string' ? (
        <>
          {!confirmed && (
            <p className="text-xs text-text-secondary">{intl.formatMessage(messages.proposed)}</p>
          )}
          <MarkdownContent content={args.content} />
        </>
      ) : (
        <>
          {typeof args.path === 'string' && (
            <p className="font-mono text-xs break-all">{args.path}</p>
          )}
          {kind === 'shell' && typeof args.command === 'string' && code(args.command)}
          {change && <FileChangeDiff change={change} />}
          {!change && kind === 'write' && typeof args.content === 'string' && (
            <>
              <p className="text-xs text-text-secondary">
                {intl.formatMessage(confirmed ? messages.submitted : messages.proposed)}
              </p>
              {code(args.content)}
            </>
          )}
          {!change && kind === 'edit' && (
            <>
              {typeof args.before === 'string' && (
                <>
                  <p>{intl.formatMessage(messages.before)}</p>
                  {code(args.before)}
                </>
              )}
              {typeof args.after === 'string' && (
                <>
                  <p>{intl.formatMessage(messages.after)}</p>
                  {code(args.after)}
                </>
              )}
            </>
          )}
          {structured && typeof structured.exit_code === 'number' && (
            <p>{intl.formatMessage(messages.exit, { code: structured.exit_code })}</p>
          )}
          {structured?.timed_out === true && (
            <p className="text-amber-700 dark:text-amber-300">
              {intl.formatMessage(messages.timeout)}
            </p>
          )}
        </>
      )}
      {output && (!isPlanTool(name) || !confirmed) && (
        <section aria-label={intl.formatMessage(messages.output)}>{code(output)}</section>
      )}
    </div>
  );
}

export function CodeProPlan({
  active = false,
  children,
  requestId,
  content,
  compact = false,
  historical = false,
}: {
  active?: boolean;
  children: ReactNode;
  requestId: string;
  content?: string;
  compact?: boolean;
  historical?: boolean;
}) {
  const intl = useIntl();
  // Checkbox state is not execution state: do not infer activity from unchecked items.
  const items = [...(content ?? '').matchAll(/^\s*(?:[-*]\s+)?\[([ xX-])\]\s+(.+)$/gm)];
  return (
    <details
      open={!compact || undefined}
      className={`codepro-disclosure group/plan my-2 text-sm ${compact ? 'codepro-disclosure-popover relative' : 'max-w-[36rem]'}`}
      data-testid="work-plan"
      data-request-id={requestId}
    >
      <summary className="codepro-secondary-label flex w-fit cursor-pointer list-none items-center gap-2 py-1 text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
        <ListChecks className="h-4 w-4" aria-hidden="true" />
        <span>{intl.formatMessage(historical ? messages.previousPlan : messages.plan)}</span>
        {compact && !historical && items.length > 0 && (
          <span className="text-xs tabular-nums">
            {items.filter((item) => item[1].toLowerCase() === 'x').length}/{items.length}
          </span>
        )}
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${compact ? 'group-open/plan:-rotate-90' : 'group-open/plan:rotate-90'}`}
          aria-hidden="true"
        />
      </summary>
      <div
        className={`codepro-operation-details overflow-y-auto overscroll-contain rounded-xl bg-background-secondary px-4 py-3 ${compact ? 'absolute bottom-full left-0 right-0 z-20 mb-2 max-h-[min(16rem,40vh)]' : 'mt-2 max-h-72'}`}
      >
        {historical && (
          <p className="mb-3 text-xs text-text-secondary">
            {intl.formatMessage(messages.previousPlanNotice)}
          </p>
        )}
        {items.length > 0 ? (
          <ul className="space-y-2.5">
            {items.map((item, index) => {
              const checked = item[1].toLowerCase() === 'x';
              const inProgress = item[1] === '-';
              const Icon = checked ? Check : inProgress ? (active ? LoaderCircle : Pause) : Circle;
              return (
                <li
                  key={index}
                  className={`flex items-start gap-3 ${checked ? 'text-text-secondary' : 'text-text-primary'}`}
                >
                  <Icon
                    className={`mt-0.5 h-4 w-4 shrink-0 ${inProgress && active ? 'animate-spin motion-reduce:animate-none' : ''}`}
                    aria-label={
                      inProgress
                        ? intl.formatMessage(active ? messages.inProgress : messages.notRunning)
                        : checked
                          ? '✓'
                          : '○'
                    }
                  />
                  <div className={`min-w-0 ${checked ? 'line-through decoration-current/40' : ''}`}>
                    <MarkdownContent content={item[2]} className="[&_p]:mb-0" />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          children
        )}
      </div>
    </details>
  );
}
