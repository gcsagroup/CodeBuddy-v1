import { describe, expect, it } from 'vitest';
import { parseToolAuditReceipt } from './toolAudit';

const validReceipt = {
  schemaVersion: 1,
  auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
  actor: 'codepro_coder',
  effectiveModel: 'openai/gpt-5.6-codex',
  extensionSource: 'platform',
  toolName: 'developer::shell',
  permissionClass: 'workspace_write',
  authorization: 'user_confirmed',
  outcome: 'success',
  taskScoped: true,
  startedAt: '2026-08-04T09:20:30.100Z',
  completedAt: '2026-08-04T09:20:30.142Z',
  durationMs: 42,
};

const validVersionTwoReceipt = {
  ...validReceipt,
  schemaVersion: 2,
  authorization: 'policy_denied',
  outcome: 'policy_denied',
  failureKind: 'policy_denied',
};

describe('parseToolAuditReceipt', () => {
  it('accepts the complete version-one safe receipt', () => {
    expect(parseToolAuditReceipt(validReceipt)).toEqual(validReceipt);
  });

  it('accepts version two only when the failure fact matches authorization and outcome', () => {
    expect(parseToolAuditReceipt(validVersionTwoReceipt)).toEqual(validVersionTwoReceipt);
    expect(
      parseToolAuditReceipt({ ...validVersionTwoReceipt, failureKind: 'user_denied' })
    ).toBeUndefined();
    expect(
      parseToolAuditReceipt({ ...validVersionTwoReceipt, failureKind: 'outside_workspace' })
    ).toBeUndefined();
  });

  it.each([
    undefined,
    { ...validReceipt, schemaVersion: 2 },
    { ...validReceipt, actor: 'spoofed_actor' },
    { ...validReceipt, toolName: 'shell' },
    { ...validReceipt, durationMs: -1 },
    { ...validReceipt, startedAt: 'not-a-timestamp' },
    { ...validReceipt, startedAt: '08/04/2026' },
    { ...validReceipt, completedAt: '2026-08-04T09:20:29.000Z' },
    { ...validReceipt, rawArguments: { command: 'secret' } },
  ])('fails closed for malformed or expanded payloads', (value) => {
    expect(parseToolAuditReceipt(value)).toBeUndefined();
  });
});
