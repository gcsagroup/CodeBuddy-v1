import { beforeEach, expect, it, vi } from 'vitest';
import { connectGitHubMcp } from './diagnostics';
import { getAcpClient } from './acpConnection';
vi.mock('./acpConnection', () => ({ getAcpClient: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('shares the same account connection between startup and Settings, then permits retry', async () => {
  let finish!: (value: unknown) => void;
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockResolvedValue({ success: true });
  vi.mocked(getAcpClient).mockResolvedValue({ extMethod: call } as never);
  const startup = connectGitHubMcp('octocat');
  const settings = connectGitHubMcp('octocat');
  expect(startup).toBe(settings);
  await Promise.resolve();
  expect(call).toHaveBeenCalledOnce();
  finish({ success: false, code: 'connection_failed' });
  expect(await settings).toEqual({ success: false, code: 'connection_failed' });
  expect(await connectGitHubMcp('octocat')).toMatchObject({ success: true });
  expect(call).toHaveBeenCalledTimes(2);
});
