import type { ReactNode } from 'react';
import { Database, Gauge } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { Message, MessageUsage } from '../types/message';
import type { TokenState } from '../types/chat';
import { cacheHitReading, formatTokensPerSecond, tokensPerSecond } from '../utils/usageFormatting';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';

const labels = defineMessages({
  live: { id: 'composerStats.live', defaultMessage: 'Current generation speed' },
  previous: { id: 'composerStats.previous', defaultMessage: 'Last sampled generation speed' },
  liveDetail: { id: 'composerStats.liveDetail', defaultMessage: 'Output tokens received per second over the latest sample of this request. ≈ indicates an estimate.' },
  speed: { id: 'composerStats.speed', defaultMessage: 'Average generation speed' },
  speedDetail: { id: 'composerStats.speedDetail', defaultMessage: 'Session average from completed model requests. Excludes first-token wait and tool execution; updates when a request completes.' },
  speedUnknown: { id: 'composerStats.speedUnknown', defaultMessage: 'Waiting for a completed request with token and timing data.' },
  cache: { id: 'composerStats.cache', defaultMessage: 'Cache hit' },
  cacheUnavailable: { id: 'composerStats.cacheUnavailable', defaultMessage: 'Not reported' },
  cacheDetail: { id: 'composerStats.cacheDetail', defaultMessage: 'Latest reported model request: {cached} cached input tokens / {prompt} total input tokens. Cache writes are not hits.' },
  cacheUnknown: { id: 'composerStats.cacheUnknown', defaultMessage: 'The latest request has no usable cache receipt yet. Missing data does not mean a 0% hit rate.' },
});

/** Read receipts only; context occupancy and rendered character counts are not billing facts. */
export function latestCacheReading(messages: Message[]) {
  let usage: MessageUsage | null | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.metadata.usage && !m.metadata.usageUnattributed && !m.metadata.usage.isCompaction) {
      usage = m.metadata.usage;
      break;
    }
  }
  return cacheHitReading(usage);
}

export function ComposerStats({ messages, stats, liveSpeed, lastSampledSpeed, children }: {
  messages: Message[];
  stats?: TokenState['sessionStats'];
  liveSpeed?: TokenState['liveSpeed'];
  lastSampledSpeed?: TokenState['lastSampledSpeed'];
  children: ReactNode;
}) {
  const intl = useIntl();
  const hasLiveRate = liveSpeed?.rate != null;
  const sample = hasLiveRate ? liveSpeed : lastSampledSpeed;
  const speed = sample?.rate ?? tokensPerSecond(stats?.decodeTokens, stats?.decodeMs);
  const speedLabel = hasLiveRate ? labels.live : sample ? labels.previous : labels.speed;
  const speedDetail = hasLiveRate ? labels.liveDetail : sample ? labels.previous : speed === null ? labels.speedUnknown : labels.speedDetail;
  const cache = latestCacheReading(messages);
  const pill = (label: string, detail: string, content: ReactNode) => (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label}
          className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 tabular-nums hover:bg-background-secondary focus-visible:outline focus-visible:outline-2">
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-xs">{detail}</TooltipContent>
    </Tooltip>
  );
  return (
    <div data-testid="composer-stats" className="flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5 px-1 pt-1 text-xs text-text-secondary">
      {pill(intl.formatMessage(speedLabel), intl.formatMessage(speedDetail), <>
        <Gauge size={14} aria-hidden="true" /><span>{speed === null ? '—' : (sample?.estimated ? '≈' : '') + formatTokensPerSecond(speed)} tok/s</span>
      </>)}
      {pill(intl.formatMessage(labels.cache), intl.formatMessage(cache ? labels.cacheDetail : labels.cacheUnknown,
        cache ? { cached: intl.formatNumber(cache.cached), prompt: intl.formatNumber(cache.prompt) } : {}), <>
        <Database size={14} aria-hidden="true" /><span>{intl.formatMessage(labels.cache)} {cache ? `${cache.percent}%` : intl.formatMessage(labels.cacheUnavailable)}</span>
      </>)}
      {children}
    </div>
  );
}
