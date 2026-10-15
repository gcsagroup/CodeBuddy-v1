import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listCapabilityUsage,
  recordCapabilitySuccess,
  recordCommonTaskSessionStarted,
} from './capabilityUsage';
import { getAcpClient } from './acpConnection';

vi.mock('./acpConnection', () => ({ getAcpClient: vi.fn() }));

describe('capability usage ACP client', () => {
  const extMethod = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);
  });

  it('lists aggregate-only usage data and preserves a recoverable warning', async () => {
    extMethod.mockResolvedValue({
      records: [
        {
          kind: 'external',
          capabilityId: 'filesystem',
          lastSuccessAt: '2026-09-04T01:02:03Z',
          successCount: 2,
          recentResult: 'read_file succeeded',
          reference: 'external:filesystem',
        },
      ],
      warning: 'previous data was repaired',
    });

    await expect(listCapabilityUsage()).resolves.toMatchObject({
      records: [{ capabilityId: 'filesystem', successCount: 2 }],
      warning: 'previous data was repaired',
    });
    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/capability-usage/list', {});
  });

  it('records one idempotent frontend success event', async () => {
    extMethod.mockResolvedValue({ recorded: true });

    await expect(
      recordCapabilitySuccess({
        eventId: 'app-open:1',
        kind: 'app',
        capabilityId: 'calculator',
        recentResult: 'initialized',
      })
    ).resolves.toBe(true);
    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/capability-usage/record-success', {
      eventId: 'app-open:1',
      kind: 'app',
      capabilityId: 'calculator',
      recentResult: 'initialized',
    });
  });

  it('records a stable common-task event after its session exists', async () => {
    const recordSuccess = vi.fn().mockResolvedValue(true);

    await recordCommonTaskSessionStarted('recipe-1', 'session-1', recordSuccess);

    expect(recordSuccess).toHaveBeenCalledWith({
      eventId: 'common-task:session-1',
      kind: 'common_task',
      capabilityId: 'recipe-1',
      recentResult: 'session started',
      reference: 'common-task:recipe-1',
    });
  });

  it('does not turn usage persistence failure into a task launch failure', async () => {
    const recordSuccess = vi.fn().mockRejectedValue(new Error('usage unavailable'));

    await expect(
      recordCommonTaskSessionStarted('recipe-1', 'session-1', recordSuccess)
    ).resolves.toBeUndefined();
  });
});
