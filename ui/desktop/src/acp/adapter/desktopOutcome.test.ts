import { describe, expect, it } from 'vitest';
import { applyToolCallUpdate } from './tools';
import type { AdapterState } from './shared';

describe('desktop outcome presentation metadata', () => {
  it.each(['paused', 'stale', 'withdrawn', 'stopped'])('preserves host outcome %s through ACP replay', (outcome) => {
    const state: AdapterState = { messages: [], localSteerTextByMessageId: new Map() };
    applyToolCallUpdate(state, { toolCallId: 'desktop', status: 'failed',
      _meta: { goose: { desktopOutcome: outcome } } });
    expect(state.messages[0].content[0]).toMatchObject({
      type: 'toolResponse', metadata: { desktopOutcome: outcome }, toolResult: { status: 'error' },
    });
  });
  it('does not infer a pause from error text', () => {
    const state: AdapterState = { messages: [], localSteerTextByMessageId: new Map() };
    applyToolCallUpdate(state, { toolCallId: 'desktop', status: 'failed',
      rawOutput: 'DESKTOP_PAUSED', _meta: { goose: { desktopOutcome: 'model_guess' } } });
    const response = state.messages[0].content[0];
    expect(response.type).toBe('toolResponse');
    if (response.type === 'toolResponse') expect(response.metadata?.desktopOutcome).toBeUndefined();
  });
});
