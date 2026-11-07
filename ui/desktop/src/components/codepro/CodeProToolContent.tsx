import MarkdownContent from '../MarkdownContent';
import '../ui/disclosure.css';
import { fileChangeReceipt, FileChangeDiff } from './CodeProFileChange';
import type { ReactNode } from 'react';
import { Check, ChevronRight, Circle, ListChecks, LoaderCircle, Pause } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import type { ToolRequestMessageContent, ToolResponseMessageContent } from '../../types/message';

const messages = defineMessages({
  planSummary: {
    id: 'codeProToolContent.planSummary',
    defaultMessage: '{completed} done · {active} in progress · {pending} pending',
  },
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

export function toolPlanContent(
  args: Record<string, unknown>,
  response?: ToolResponseMessageContent
): string | undefined {
  if (typeof args.content === 'string') return args.content;
  const result = response?.toolResult;
  const value =
    result?.status === 'success' && result.value && typeof result.value === 'object'
      ? (result.value as Record<string, unknown>)
      : undefined;
  const raw = value?.structuredContent;
  const todos = raw && typeof raw === 'object' && 'todos' in raw ? raw.todos : args.todos;
  if (
    !Array.isArray(todos) ||
    !todos.every(
      (item) =>
        item &&
        typeof item.content === 'string' &&
        ['pending', 'in_progress', 'completed'].includes(item.status)
    )
  )
    return;
  return todos
    .map(
      (item) =>
        `- [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '-' : ' '}] ${item.content}`
    )
    .join('\n');
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
  return [
    'shell',
    'pwsh',
    'bash',
    'write',
    'edit',
    'read',
    'read_document',
    'glob',
    'grep',
    'todo_write',
  ].includes(name.split(/__|::/).pop() ?? '');
}

// This view consumes requests and receipts; submitted code is not a before/after
// workspace diff, and a checked plan item is not a completed run.
export function CodeProToolContent({
  name,
  args,
  response,
  request,
}: {
  name: string;
  args: Record<string, unknown>;
  response?: ToolResponseMessageContent;
  request?: ToolRequestMessageContent;
}) {
  const intl = useIntl();
  const kind = name.split(/__|::/).pop();
  const change = fileChangeReceipt(response, request);
  const planContent = toolPlanContent(args, response);
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
      {isPlanTool(name) && planContent !== undefined ? (
        <>
          {!confirmed && (
            <p className="text-xs text-text-secondary">{intl.formatMessage(messages.proposed)}</p>
          )}
          <MarkdownContent content={planContent} />
        </>
      ) : (
        <>
          {typeof (args.file_path ?? args.path) === 'string' && (
            <p className="font-mono text-xs break-all">{String(args.file_path ?? args.path)}</p>
          )}
          {(kind === 'glob' || kind === 'grep') &&
            typeof args.pattern === 'string' &&
            code(args.pattern)}
          {(kind === 'glob' || kind === 'grep') &&
            typeof args.include === 'string' &&
            code(args.include)}
          {['shell', 'pwsh', 'bash'].includes(kind ?? '') &&
            typeof args.command === 'string' &&
            code(args.command)}
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
      open={compact ? undefined : true}
      className={`codepro-plan codepro-disclosure group/plan my-1 w-full ${compact ? 'overflow-hidden rounded-2xl border border-border-primary/60 bg-background-secondary/40 text-sm shadow-sm' : 'text-xs'}`}
      data-testid="work-plan"
      data-plan-card={compact || undefined}
      data-request-id={requestId}
    >
      <summary className={`flex w-full cursor-pointer list-none items-center gap-2 text-text-secondary hover:bg-background-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-primary [&::-webkit-details-marker]:hidden ${compact ? 'px-4 py-3' : 'codepro-secondary-label rounded-lg px-2 py-1.5'}`}>
        <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium text-text-primary">{intl.formatMessage(historical ? messages.previousPlan : messages.plan)}</span>
        {compact && !historical && items.length > 0 && (
          <span className="min-w-0 text-xs tabular-nums sm:text-sm">
            {intl.formatMessage(messages.planSummary, {
              completed: items.filter((item) => item[1].toLowerCase() === 'x').length,
              active: items.filter((item) => item[1] === '-').length,
              pending: items.filter((item) => item[1] === ' ').length,
            })}
          </span>
        )}
        <ChevronRight
          className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open/plan:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div
        className={`codepro-operation-details overflow-y-auto overscroll-contain ${compact ? 'mx-2 mb-2 max-h-[min(14rem,30vh)] px-2 [scrollbar-width:thin] [scrollbar-color:var(--border-primary)_transparent]' : 'mt-2 max-h-72 rounded-xl bg-background-secondary px-3 py-2'}`}
      >
        {historical && (
          <p className="mb-3 text-xs text-text-secondary">
            {intl.formatMessage(messages.previousPlanNotice)}
          </p>
        )}
        {items.length > 0 ? (
          <ul className={compact ? 'space-y-0.5' : 'space-y-1'}>
            {items.map((item, index) => {
              const checked = item[1].toLowerCase() === 'x';
              const inProgress = item[1] === '-';
              const Icon = checked ? Check : inProgress ? (active ? LoaderCircle : Pause) : Circle;
              return (
                <li
                  key={index}
                  className={`flex ${compact ? 'items-center gap-3 py-1.5 text-sm leading-5 text-text-secondary' : `items-start gap-1 ${checked ? 'text-text-secondary' : 'text-text-primary'}`}`}
                >
                  {compact && !inProgress ? (
                    <span className="flex size-4 shrink-0 items-center justify-center" role="img" aria-label={checked ? '✓' : '○'}>
                      <span className={`size-[7px] rounded-full ${checked ? 'bg-emerald-500' : 'bg-text-secondary/30'}`} />
                    </span>
                  ) : <Icon
                    className={`mt-0.5 h-4 w-4 shrink-0 ${inProgress && active ? 'animate-spin motion-reduce:animate-none' : ''}`}
                    aria-label={
                      inProgress
                        ? intl.formatMessage(active ? messages.inProgress : messages.notRunning)
                        : checked
                          ? '✓'
                          : '○'
                    }
                  />}
                  <div className={compact ? 'min-w-0 flex-1 overflow-hidden' : 'min-w-0 break-words'} title={compact ? item[2] : undefined}>
                    <MarkdownContent content={item[2]} className={compact ? '[&_p]:mb-0 [&_p]:truncate [&_p]:leading-5' : '[&_p]:mb-0'} />
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
