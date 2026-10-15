import { describe, expect, it } from 'vitest';
import {
  getSkillManagementConfirmationsSnapshot,
  requestSkillManagementConfirmation,
  resolveSkillManagementConfirmation,
} from './skillConfirmationRequests';

describe('skill management confirmation requests', () => {
  it('binds the response to the server nonce and exact preview', async () => {
    const response = requestSkillManagementConfirmation({
      previewToken: 'preview-1',
      nonce: 'server-nonce',
      operation: 'delete',
      target: 'demo',
      expiresAt: '2026-09-05T00:00:00Z',
    });
    expect(getSkillManagementConfirmationsSnapshot()).toHaveLength(1);
    expect(resolveSkillManagementConfirmation('forged-preview', 'confirm')).toBe(false);
    expect(resolveSkillManagementConfirmation('preview-1', 'confirm')).toBe(true);
    await expect(response).resolves.toEqual({ decision: 'confirm', nonce: 'server-nonce' });
    expect(getSkillManagementConfirmationsSnapshot()).toHaveLength(0);
  });
});
