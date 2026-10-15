import { describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../acpConnection';
import { acpLoadSession } from '../sessions';

vi.mock('../acpConnection', () => ({ getAcpClient: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clientFixture() {
  const first = deferred<Record<string, unknown>>();
  const client = {
    goose: {
      sessionInfo_unstable: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        session: { sessionId, cwd: 'D:/Fixture/A', _meta: { sessionType: 'code_pro' } },
      })),
    },
    loadSession: vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({}),
  };
  vi.mocked(getAcpClient).mockResolvedValue(client as never);
  return { first, client };
}

describe('session load concurrency', () => {
  it('coalesces identical loads without consuming the same lease twice', async () => {
    const { first, client } = clientFixture();
    const options = { cwd: 'D:/Fixture/A', workspaceLeaseId: 'lease-a' };
    const a = acpLoadSession('same-options', options);
    const b = acpLoadSession('same-options', { ...options });
    await vi.waitFor(() => expect(client.loadSession).toHaveBeenCalledOnce());
    first.resolve({});
    await Promise.all([a, b]);
    expect(client.loadSession).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'preserves a distinct confirmed load after a pending load (rejected=%s)',
    async (rejectFirst) => {
      const { first, client } = clientFixture();
      const a = acpLoadSession('changed-options').catch(() => undefined);
      await vi.waitFor(() => expect(client.loadSession).toHaveBeenCalledOnce());
      const b = acpLoadSession('changed-options', {
        cwd: 'D:/Fixture/B',
        workspaceLeaseId: 'confirmed-b',
      }).catch((error: unknown) => error);
      expect(client.loadSession).toHaveBeenCalledOnce();
      if (rejectFirst) first.reject(new Error('old load cancelled'));
      else first.resolve({});
      await Promise.all([a, b]);
      expect(client.loadSession).toHaveBeenCalledTimes(2);
      expect(client.loadSession).toHaveBeenLastCalledWith({
        sessionId: 'changed-options',
        cwd: 'D:/Fixture/B',
        mcpServers: [],
        _meta: { workspaceLeaseId: 'confirmed-b' },
      });
    }
  );

  it('keeps another session independent when the first response arrives late', async () => {
    const { first, client } = clientFixture();
    const a = acpLoadSession('window-a', { cwd: 'D:/Fixture/A', workspaceLeaseId: 'lease-a' });
    await vi.waitFor(() => expect(client.loadSession).toHaveBeenCalledOnce());
    const b = await acpLoadSession('window-b', {
      cwd: 'D:/Fixture/B',
      workspaceLeaseId: 'lease-b',
    });
    expect(b.sessionInfo.sessionId).toBe('window-b');
    first.resolve({});
    expect((await a).sessionInfo.sessionId).toBe('window-a');
    expect(
      client.loadSession.mock.calls.map(([request]) => request._meta.workspaceLeaseId)
    ).toEqual(['lease-a', 'lease-b']);
  });
});
