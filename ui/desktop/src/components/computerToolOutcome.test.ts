import { describe, expect, it } from 'vitest';
import captured from './fixtures/computer-unknown.json';
import { computerToolOutcome } from './computerToolOutcome';
import type { ToolResponseMessageContent } from '../types/message';

const id = captured.request.id;
function fixture(outcome = 'unknown') {
  const response = globalThis.structuredClone(captured.response);
  const body = JSON.parse(response.toolResult.value.content[0].text);
  body.outcome = outcome;
  body.verification.matched = outcome === 'worked';
  response.toolResult.value.content[0].text = JSON.stringify(body);
  return response;
}
const resolve = (response: unknown, name = 'computer_focus', requestId = id) =>
  computerToolOutcome(name, requestId, response as ToolResponseMessageContent);

describe('computer action receipt mapping', () => {
  it.each([
    ['unknown', 'unknown'],
    ['worked', 'worked'],
    ['didnt', 'failed'],
    ['failed', 'failed'],
    ['rejected', 'rejected'],
  ])('maps %s precisely', (outcome, expected) => {
    expect(resolve(fixture(outcome))).toBe(expected);
  });
  it('does not mutate the captured audit or infer success from a later observation', () => {
    const response = fixture();
    const before = JSON.stringify(response);
    expect(resolve(response)).toBe('unknown');
    expect(resolve(fixture('worked'), 'computer_observe')).toBeUndefined();
    expect(resolve(response)).toBe('unknown');
    expect(JSON.stringify(response)).toBe(before);
  });
  it('does not parse unrelated or external tools', () => {
    expect(resolve(fixture(), 'other__computer_focus')).toBeUndefined();
    const response = fixture();
    response.metadata.toolAudit.extensionSource = 'external_stdio';
    expect(resolve(response)).toBeUndefined();
  });
  it('keeps calls without a response waiting', () => {
    expect(resolve(undefined)).toBeUndefined();
  });
  it('requires matching response, trace and action before worked', () => {
    expect(resolve(fixture('worked'), 'computer_focus', 'another-call')).toBe('unknown');
    for (const field of ['step_id', 'attempt_id']) {
      const response = fixture('worked');
      const body = JSON.parse(response.toolResult.value.content[0].text);
      body.trace[field] = 'another-call';
      response.toolResult.value.content[0].text = JSON.stringify(body);
      expect(resolve(response)).toBe('unknown');
    }
    const response = fixture('worked');
    const body = JSON.parse(response.toolResult.value.content[0].text);
    body.performed.action = 'click';
    response.toolResult.value.content[0].text = JSON.stringify(body);
    expect(resolve(response)).toBe('unknown');
  });
  it.each(['{', '{}', '{"outcome":"worked"}', 'null'])(
    'does not infer success from malformed %s',
    (text) => {
      const response = fixture('worked');
      response.toolResult.value.content[0].text = text;
      expect(resolve(response)).toBe('unknown');
    }
  );
  it('requires verification and no tool error for worked', () => {
    const response = fixture('worked');
    const body = JSON.parse(response.toolResult.value.content[0].text);
    body.verification.matched = false;
    response.toolResult.value.content[0].text = JSON.stringify(body);
    expect(resolve(response)).toBe('unknown');
    const failed = fixture('worked');
    failed.toolResult.value.isError = true;
    expect(resolve(failed)).toBe('unknown');
  });
});

it('does not promote mismatched audit identity or contradictory verification to worked', () => {
  const response = fixture('worked');
  response.metadata.toolAudit.toolName = 'computer::computer_click';
  expect(resolve(response)).toBe('unknown');
  const contradictory = fixture('worked');
  const body = JSON.parse(contradictory.toolResult.value.content[0].text);
  body.verification.matched_before_action = true;
  body.verification.attributable_target_transition = false;
  contradictory.toolResult.value.content[0].text = JSON.stringify(body);
  expect(resolve(contradictory)).toBe('unknown');
});

it.each([null, 'invalid receipt', []])(
  'marks malformed successful value %j unconfirmed',
  (value) => {
    const response = { ...fixture(), toolResult: { status: 'success', value } };
    expect(resolve(response)).toBe('unknown');
  }
);

it.each([undefined, { status: 'pending' }, { status: 'error', error: 'transport failed' }])(
  'leaves non-success transport %j to the transport renderer',
  (toolResult) => {
    expect(resolve({ ...fixture(), toolResult })).toBeUndefined();
  }
);
