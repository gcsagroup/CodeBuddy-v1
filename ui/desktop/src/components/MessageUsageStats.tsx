import { Fragment, type ReactNode } from 'react';
import { Zap } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';
import { defineMessages, useIntl } from '../i18n';
import { cn } from '../utils';
import type { MessageUsage } from '../types/message';
import {
  formatCost,
  formatDuration,
  formatTokenCount,
  formatTokensPerSecond,
  tokensPerSecond,
} from '../utils/usageFormatting';

const i18n = defineMessages({
  tokensPerSecondUnit: {
    id: 'messageUsageStats.tokensPerSecondUnit',
    defaultMessage: 'tok/s',
  },
  tokenUnit: {
    id: 'messageUsageStats.tokenUnit',
    defaultMessage: 'tok',
  },
  input: {
    id: 'messageUsageStats.input',
    defaultMessage: 'Input',
  },
  cacheRead: {
    id: 'messageUsageStats.cacheRead',
    defaultMessage: 'Cache hit',
  },
  cacheWrite: {
    id: 'messageUsageStats.cacheWrite',
    defaultMessage: 'cache write',
  },
  cacheHitRate: {
    id: 'messageUsageStats.cacheHitRate',
    defaultMessage: '{percent}%',
  },
  output: {
    id: 'messageUsageStats.output',
    defaultMessage: 'Output',
  },
  total: {
    id: 'messageUsageStats.total',
    defaultMessage: 'Total',
  },
  firstToken: {
    id: 'messageUsageStats.firstToken',
    defaultMessage: 'First token',
  },
  totalTime: {
    id: 'messageUsageStats.totalTime',
    defaultMessage: 'Total time',
  },
  speed: {
    id: 'messageUsageStats.speed',
    defaultMessage: 'Speed',
  },
  cost: {
    id: 'messageUsageStats.cost',
    defaultMessage: 'Cost',
  },
  estimated: {
    id: 'messageUsageStats.estimated',
    defaultMessage: '(estimated)',
  },
  reported: {
    id: 'messageUsageStats.reported',
    defaultMessage: '(reported)',
  },
  compaction: {
    id: 'messageUsageStats.compaction',
    defaultMessage: 'Compaction',
  },
});

function hasValue(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** One label/value row of the tooltip's stats card. */
function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-8">
      <span className="text-text-secondary">{label}</span>
      <span className="tabular-nums text-right text-text-primary">{value}</span>
    </div>
  );
}

/**
 * Per-message usage chip (tok/s, cost, total tokens) with a tooltip breaking
 * down tokens, caching, timing, and cost. Renders nothing without data.
 */
export default function MessageUsageStats({
  usage,
  compact = false,
}: {
  usage: MessageUsage;
  compact?: boolean;
}) {
  const intl = useIntl();
  const {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
    costSource,
    elapsedMs,
    timeToFirstTokenMs,
    isCompaction,
  } = usage;

  const tps = tokensPerSecond(outputTokens, elapsedMs);

  const chipSegments: ReactNode[] = [];
  if (tps !== null) {
    chipSegments.push(
      <span key="tps" className="flex items-center gap-1">
        <Zap className="h-3 w-3" aria-hidden="true" />
        {formatTokensPerSecond(tps)} {intl.formatMessage(i18n.tokensPerSecondUnit)}
      </span>
    );
  }
  if (hasValue(cost)) {
    chipSegments.push(
      <span key="cost">
        {costSource === 'estimated' ? '~' : ''}
        {formatCost(cost)}
      </span>
    );
  }
  if (hasValue(totalTokens)) {
    chipSegments.push(
      <span key="tokens">
        {formatTokenCount(totalTokens)} {intl.formatMessage(i18n.tokenUnit)}
      </span>
    );
  }

  if (chipSegments.length === 0) {
    return null;
  }

  const hasTokensSection =
    hasValue(inputTokens) ||
    hasValue(outputTokens) ||
    hasValue(totalTokens) ||
    hasValue(cacheReadTokens) ||
    hasValue(cacheWriteTokens);
  const hasTimingSection = hasValue(timeToFirstTokenMs) || hasValue(elapsedMs) || tps !== null;
  const hasCostSection = hasValue(cost);
  const cacheHitPercent =
    hasValue(cacheReadTokens) &&
    hasValue(inputTokens) &&
    inputTokens > 0 &&
    cacheReadTokens >= 0 &&
    cacheReadTokens <= inputTokens
      ? Math.round((cacheReadTokens / inputTokens) * 100)
      : undefined;

  const section = 'space-y-1';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          aria-label={intl.formatMessage(i18n.total)}
          className="flex items-center gap-2 text-xs leading-4 text-text-secondary hover:text-text-primary transition-colors cursor-default tabular-nums"
        >
          {compact ? (
            <>
              <Zap className="h-3 w-3" aria-hidden="true" />
              {hasValue(inputTokens) && (
                <span>
                  {intl.formatMessage(i18n.input)} {formatTokenCount(inputTokens)}
                </span>
              )}
              {hasValue(outputTokens) && (
                <span>
                  {intl.formatMessage(i18n.output)} {formatTokenCount(outputTokens)}
                </span>
              )}
              {!hasValue(inputTokens) && !hasValue(outputTokens) && hasValue(totalTokens) && (
                <span>{formatTokenCount(totalTokens)}</span>
              )}
              <span>{intl.formatMessage(i18n.tokenUnit)}</span>
            </>
          ) : (
            chipSegments.map((segment, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="text-text-tertiary">·</span>}
                {segment}
              </Fragment>
            ))
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        className="px-3.5 py-2.5 rounded-lg text-left bg-background-secondary text-text-primary shadow-md"
        arrowClassName="bg-background-secondary fill-background-secondary"
      >
        <div className="min-w-44 text-xs leading-5 space-y-1">
          {hasTokensSection && (
            <div className={section}>
              {hasValue(inputTokens) && (
                <StatRow
                  label={intl.formatMessage(i18n.input)}
                  value={formatTokenCount(inputTokens)}
                />
              )}
              {hasValue(outputTokens) && (
                <StatRow
                  label={intl.formatMessage(i18n.output)}
                  value={formatTokenCount(outputTokens)}
                />
              )}
              {hasValue(totalTokens) && (
                <StatRow
                  label={intl.formatMessage(i18n.total)}
                  value={formatTokenCount(totalTokens)}
                />
              )}
              {cacheHitPercent !== undefined && (
                <StatRow
                  label={intl.formatMessage(i18n.cacheRead)}
                  value={intl.formatMessage(i18n.cacheHitRate, { percent: cacheHitPercent })}
                />
              )}
            </div>
          )}

          {hasTimingSection && (
            <div className={section}>
              {hasValue(timeToFirstTokenMs) && (
                <StatRow
                  label={intl.formatMessage(i18n.firstToken)}
                  value={formatDuration(timeToFirstTokenMs)}
                />
              )}
              {hasValue(elapsedMs) && (
                <StatRow
                  label={intl.formatMessage(i18n.totalTime)}
                  value={formatDuration(elapsedMs)}
                />
              )}
              {tps !== null && (
                <StatRow
                  label={intl.formatMessage(i18n.speed)}
                  value={`${formatTokensPerSecond(tps)} ${intl.formatMessage(i18n.tokensPerSecondUnit)}`}
                />
              )}
            </div>
          )}

          {hasValue(cacheWriteTokens) && (
            <StatRow
              label={intl.formatMessage(i18n.cacheWrite)}
              value={formatTokenCount(cacheWriteTokens)}
            />
          )}
          {hasCostSection && (
            <div className={section}>
              {hasValue(cost) && (
                <StatRow
                  label={intl.formatMessage(i18n.cost)}
                  value={
                    <>
                      {formatCost(cost)}
                      {(costSource === 'provider_reported' || costSource === 'estimated') && (
                        <span className="text-text-secondary">
                          {' '}
                          {intl.formatMessage(
                            costSource === 'provider_reported' ? i18n.reported : i18n.estimated
                          )}
                        </span>
                      )}
                    </>
                  }
                />
              )}
            </div>
          )}

          {isCompaction && (
            <div className={cn(section, 'text-text-warning')}>
              {intl.formatMessage(i18n.compaction)}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
