import type { GitHubCiRun } from '@aaif/goose-sdk';
import { describe, expect, it } from 'vitest';
import { eligibleForCancel } from './githubCiCancel';

function run(status: GitHubCiRun['status']): GitHubCiRun {
  return {
    id: 42,
    name: 'CI',
    runNumber: 9,
    attempt: 1,
    event: 'push',
    status,
    conclusion: null,
    htmlUrl: 'https://github.com/octo/demo/actions/runs/42',
    createdAt: '2026-08-05T01:00:00Z',
    updatedAt: '2026-08-05T01:01:00Z',
  };
}

describe('eligibleForCancel', () => {
  it('accepts only positive queued or in-progress workflow runs', () => {
    expect(eligibleForCancel(run('queued'))).toBe(true);
    expect(eligibleForCancel(run('in_progress'))).toBe(true);

    for (const status of ['waiting', 'requested', 'pending', 'completed', 'unknown'] as const) {
      expect(eligibleForCancel(run(status))).toBe(false);
    }
    expect(eligibleForCancel({ ...run('queued'), id: 0 })).toBe(false);
  });
});
