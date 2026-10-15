import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import {
  auditRootCleanup,
  cancelRootCleanup,
  executeRootCleanup,
  listRootCleanupRecoveries,
  permanentlyDeleteQuarantinedCleanup,
  retryRootCleanupRecovery,
  restoreQuarantinedCleanup,
} from './rootCleanup';

vi.mock('./acpConnection', () => ({ getAcpClient: vi.fn() }));

describe('root cleanup ACP contract', () => {
  beforeEach(() => vi.clearAllMocks());

  const capability = {
    sessionId: 'session-1',
    runId: 'run-1',
    sourceMessageId: 'message-1',
    nonce: 'nonce-1',
  };

  it('keeps audit, execute, and cancel as three bounded methods', async () => {
    const response = {
      auditToken: 'audit-1',
      rootIdentity: 'd:',
      target: {
        relativePath: 'fixture.tmp',
        targetType: 'file',
        bytes: 7,
        modifiedMillis: 1,
        hash: 'abc',
      },
      destructiveConfirmationRequired: true,
    };
    const quarantine = {
      quarantineToken: 'quarantine-1',
      target: response.target,
      permanentConfirmationRequired: true,
    };
    const extMethod = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(quarantine);
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

    await expect(auditRootCleanup('D:\\', 'D:\\fixture.tmp', capability)).resolves.toEqual(
      response
    );
    await executeRootCleanup('audit-1', capability);
    await permanentlyDeleteQuarantinedCleanup('quarantine-1', capability);
    await restoreQuarantinedCleanup('quarantine-2', capability);
    await cancelRootCleanup('audit-2', capability);

    expect(extMethod).toHaveBeenNthCalledWith(1, '_goose/unstable/root-cleanup/audit', {
      rootPath: 'D:\\',
      targets: ['D:\\fixture.tmp'],
      capability,
    });
    expect(extMethod).toHaveBeenNthCalledWith(2, '_goose/unstable/root-cleanup/execute', {
      auditToken: 'audit-1',
      capability,
    });
    expect(extMethod).toHaveBeenNthCalledWith(3, '_goose/unstable/root-cleanup/permanent-delete', {
      quarantineToken: 'quarantine-1',
      capability,
    });
    expect(extMethod).toHaveBeenNthCalledWith(
      4,
      '_goose/unstable/root-cleanup/restore-quarantine',
      {
        quarantineToken: 'quarantine-2',
        capability,
      }
    );
    expect(extMethod).toHaveBeenNthCalledWith(5, '_goose/unstable/root-cleanup/cancel', {
      auditToken: 'audit-2',
      capability,
    });
  });

  it('binds recovery listing and retry to an active session', async () => {
    const recovery = {
      quarantineToken: 'recovery-1',
      phase: 'orphan',
      originalPath: 'D:\\cache\\fixture.tmp',
      quarantinePath: 'D:\\cache\\.codeagentpro-quarantine-recovery-1\\target',
      retryOriginalAvailable: true,
    };
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ recoveries: [recovery] })
      .mockResolvedValueOnce({ restored: false, revealPath: recovery.quarantinePath });
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

    await expect(listRootCleanupRecoveries(capability)).resolves.toEqual([recovery]);
    await expect(retryRootCleanupRecovery(capability, 'recovery-1')).resolves.toEqual({
      restored: false,
      revealPath: recovery.quarantinePath,
    });
    expect(extMethod).toHaveBeenNthCalledWith(1, '_goose/unstable/root-cleanup/recovery/list', {
      capability,
    });
    expect(extMethod).toHaveBeenNthCalledWith(
      2,
      '_goose/unstable/root-cleanup/recovery/retry-original',
      { capability, quarantineToken: 'recovery-1' }
    );
  });
});

describe('read-only cleanup capability', () => {
  const capability = { sessionId: 's', runId: 'r', sourceMessageId: 'm', nonce: 'n' };
  const audit = {
    auditToken: 'a',
    rootIdentity: '/',
    destructiveConfirmationRequired: true,
    target: {
      relativePath: 'private/tmp/中文.tmp',
      targetType: 'file',
      bytes: 1,
      modifiedMillis: 1,
      hash: 'h',
    },
  };
  it('preserves false and accepts legacy missing availability', async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ ...audit, executionAvailable: false })
      .mockResolvedValueOnce(audit);
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);
    expect(
      (await auditRootCleanup('/', '/private/tmp/中文.tmp', capability)).executionAvailable
    ).toBe(false);
    expect(
      (await auditRootCleanup('/', '/private/tmp/中文.tmp', capability)).executionAvailable
    ).toBeUndefined();
  });
  it.each(['false', 0, null, {}])(
    'rejects malformed execution availability %j',
    async (executionAvailable) => {
      const extMethod = vi.fn().mockResolvedValue({ ...audit, executionAvailable });
      vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);
      await expect(auditRootCleanup('/', '/tmp/a', capability)).rejects.toThrow(
        'Invalid root cleanup audit response'
      );
    }
  );
});
