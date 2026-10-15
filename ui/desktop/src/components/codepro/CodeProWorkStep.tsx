import type { ReactNode } from 'react';
import MarkdownContent from '../MarkdownContent';
import { ToolCallExpandable } from '../ToolCallExpandable';

/** Public commentary separates steps; only settled operation history folds. */
export function CodeProWorkStep({
  text,
  streaming,
  settled,
  summary,
  operationCount,
  storageKey,
  children,
}: {
  text: string;
  streaming: boolean;
  settled: boolean;
  summary: string;
  operationCount: number;
  storageKey: string;
  children?: ReactNode;
}) {
  const operations = children ? <div className="codepro-tool-group mt-1">{children}</div> : null;
  return (
    <section className="my-2.5 w-full max-w-[52rem]" data-testid="work-step">
      <div className="flex items-start gap-2 text-sm text-text-primary">
        <div className="min-w-0 flex-1" aria-busy={streaming}>
          <MarkdownContent content={text} animateIncoming={streaming} />
          {streaming && (
            <span aria-hidden className="inline-block h-3 w-1 bg-current animate-pulse" />
          )}
        </div>
      </div>
      {operations && (
        <ToolCallExpandable
          compact
          groupHeading
          scrollable={false}
          storageKey={storageKey}
          label={summary}
          collapsible={settled && operationCount > 1 && !!summary}
        >
          {operations}
        </ToolCallExpandable>
      )}
    </section>
  );
}
