import { describe, expect, it, vi } from 'vitest';
import { grantCodeProRestrictedReadonly } from './codeproPermissions';
import { getAcpClient } from './acpConnection';

vi.mock('./acpConnection');

describe('codeproPermissions', () => {
  describe('grantCodeProRestrictedReadonly', () => {
    it('calls the custom ACP method with the session id', async () => {
      const extMethod = vi.fn().mockResolvedValue(undefined);
      vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

      await grantCodeProRestrictedReadonly('session-1');

      expect(extMethod).toHaveBeenCalledWith(
        '_goose/unstable/codepro/workspace/grant-restricted-readonly',
        { sessionId: 'session-1' }
      );
    });

    it('propagates errors from the ACP client', async () => {
      const error = new Error('access denied');
      const extMethod = vi.fn().mockRejectedValue(error);
      vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

      await expect(grantCodeProRestrictedReadonly('session-1')).rejects.toThrow('access denied');
    });
  });
});
