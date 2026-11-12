import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, MessageUsage } from '../types/message';
import { ComposerStats, latestCacheReading } from './ComposerStats';

const message = (usage: MessageUsage): Message => ({
  id: 'reply', role: 'assistant', created: 1, content: [],
  metadata: { userVisible: true, agentVisible: true, usage },
});

it('switches from live measured or estimated output to the completed session speed', () => {
  const stats = { decodeTokens: 32, decodeMs: 1000 };
  const view = (liveSpeed: { rate: number | null; estimated: boolean } | null, lastSampledSpeed?: { rate: number; estimated: boolean }) =>
    <ComposerStats messages={[]} stats={stats} liveSpeed={liveSpeed} lastSampledSpeed={lastSampledSpeed}>{null}</ComposerStats>;
  const { rerender } = render(view({ rate: null, estimated: false }), { wrapper: IntlTestWrapper });
  expect(screen.getByRole('button', { name: 'Average generation speed' })).toHaveTextContent('32.0 tok/s');
  rerender(view({ rate: 25, estimated: false }));
  expect(screen.getByRole('button', { name: 'Current generation speed' })).toHaveTextContent('25.0 tok/s');
  rerender(view({ rate: 15, estimated: true }));
  expect(screen.getByText('≈15.0 tok/s')).toBeVisible();
  rerender(view({ rate: null, estimated: false }, { rate: 15, estimated: true }));
  expect(screen.getByRole('button', { name: 'Last sampled generation speed' })).toHaveTextContent('≈15.0 tok/s');
  rerender(view({ rate: 0, estimated: false }, { rate: 15, estimated: true }));
  expect(screen.getByRole('button', { name: 'Current generation speed' })).toHaveTextContent('0.00 tok/s');
  rerender(view(null));
  expect(screen.getByRole('button', { name: 'Average generation speed' })).toHaveTextContent('32.0 tok/s');
});

it('uses the complete input denominator and the latest request, preserving zero and unknown', () => {
  const cached = message({ inputTokens: 180, cacheReadTokens: 820, outputTokens: 40, totalTokens: 1040 });
  expect(latestCacheReading([cached])).toEqual({ cached: 820, prompt: 1000, percent: '82' });
  expect(latestCacheReading([cached, message({ inputTokens: 20, cacheReadTokens: 0 })])?.percent).toBe('0');
  expect(latestCacheReading([cached, message({ inputTokens: 20 })])).toBeNull();
  expect(latestCacheReading([message({ inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 })])?.percent).toBe('80');
  expect(latestCacheReading([message({ totalTokens: 100, outputTokens: 10, cacheReadTokens: 200 })])).toBeNull();
  expect(latestCacheReading([message({ inputTokens: 1, cacheReadTokens: 9999 })])?.percent).toBe('<100');
});

it('renders native session speed alongside recent cache usage and the context control', () => {
  render(<ComposerStats stats={{ decodeTokens: 440, decodeMs: 2000 }}
    messages={[message({ inputTokens: 180, cacheReadTokens: 820 })]}>
    <button>Context 3%</button>
  </ComposerStats>, { wrapper: IntlTestWrapper });
  expect(screen.getByText('220 tok/s')).toBeVisible();
  expect(screen.getByText('Cache hit 82%')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Context 3%' })).toBeVisible();
});

it('does not manufacture numbers before data or reuse a compaction receipt', () => {
  render(<ComposerStats messages={[]} stats={{ decodeTokens: 0, decodeMs: 0 }}>{null}</ComposerStats>, { wrapper: IntlTestWrapper });
  expect(screen.getByText('— tok/s')).toBeVisible();
  expect(screen.getByText('Cache hit Not reported')).toBeVisible();
  expect(latestCacheReading([message({ inputTokens: 50, cacheReadTokens: 40, isCompaction: true })])).toBeNull();
});
