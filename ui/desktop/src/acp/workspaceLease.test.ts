import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient, getAcpInitializeResponse } from './acpConnection';
import {
  acquireWorkspaceLease,
  allocateWorkspaceChild,
  allocateProjectChild,
  releaseWorkspaceLease,
  refreshWorkspaceConfirmation,
} from './workspaceLease';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
  getAcpInitializeResponse: vi.fn(),
}));

describe('workspace lease ACP contract', () => {
  beforeEach(() => vi.clearAllMocks());

  const capability = {
    sessionId: 'session-1',
    runId: 'run-1',
    sourceMessageId: 'message-1',
    nonce: 'nonce-1',
  };

  it('acquires one authoritative workspace without changing the requested identity contract', async () => {
    const extMethod = vi.fn().mockResolvedValue({
      leaseId: 'lease-1',
      workingDir: 'D:\\Canonical\\Ledger',
      normalizedIdentity: 'd:\\canonical\\ledger',
      created: true,
    });
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

    await expect(
      acquireWorkspaceLease({
        requestedPath: 'D:\\Alias\\Ledger',
        expectedIdentity: 'd:\\canonical\\ledger',
        expectedState: 'missing',
      })
    ).resolves.toEqual({
      leaseId: 'lease-1',
      workingDir: 'D:\\Canonical\\Ledger',
      normalizedIdentity: 'd:\\canonical\\ledger',
      created: true,
    });
    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/workspace/lease/acquire', {
      requestedPath: 'D:\\Alias\\Ledger',
      expectedIdentity: 'd:\\canonical\\ledger',
      expectedState: 'missing',
    });
  });

  it('fails closed on a malformed lease response', async () => {
    vi.mocked(getAcpClient).mockResolvedValue({
      extMethod: vi.fn().mockResolvedValue({ leaseId: '', workingDir: 'D:\\Ledger' }),
    } as never);

    await expect(
      acquireWorkspaceLease({
        requestedPath: 'D:\\Ledger',
        expectedIdentity: 'd:\\ledger',
        expectedState: 'empty-directory',
      })
    ).rejects.toThrow('Invalid workspace lease response');
  });

  it('releases an unconsumed lease through the bounded method', async () => {
    const extMethod = vi.fn().mockResolvedValue({});
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

    await releaseWorkspaceLease('lease-1');

    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/workspace/lease/release', {
      leaseId: 'lease-1',
    });
  });

  it('asks the backend to atomically allocate a unique child below the confirmed root', async () => {
    const response = {
      leaseId: 'lease-child',
      workingDir: 'D:\\invoice-parser-2',
      normalizedIdentity: 'd:\\invoice-parser-2',
      created: true,
    };
    const extMethod = vi.fn().mockResolvedValue(response);
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);

    await expect(
      allocateWorkspaceChild({
        containerPath: 'D:\\',
        suggestedName: 'invoice-parser',
        capability,
      })
    ).resolves.toEqual(response);
    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/workspace/lease/allocate-child', {
      containerPath: 'D:\\',
      suggestedName: 'invoice-parser',
      capability,
    });
  });
});

it('negotiates project-container version before sending a creation request', async () => {
  const extMethod = vi.fn().mockResolvedValue({
    leaseId: 'new',
    workingDir: '/Users/test/Projects/child',
    normalizedIdentity: '/Users/test/Projects/child',
    created: true,
  });
  vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);
  const input = {
    containerPath: '/Users/test/Projects',
    suggestedName: 'child',
    capability: { sessionId: 'session', runId: 'run', sourceMessageId: 'message', nonce: 'nonce' },
  };
  vi.mocked(getAcpInitializeResponse).mockResolvedValue({ agentCapabilities: {} } as never);
  await expect(allocateProjectChild(input)).rejects.toThrow('Upgrade');
  expect(extMethod).not.toHaveBeenCalled();
  vi.mocked(getAcpInitializeResponse).mockResolvedValue({
    agentCapabilities: { _meta: { goose: { projectContainers: 1 } } },
  } as never);
  await expect(allocateProjectChild(input)).resolves.toMatchObject({ created: true });
  expect(extMethod).toHaveBeenCalledWith(
    '_goose/unstable/workspace/project-container/v1/allocate-child',
    input
  );
});

it('negotiates refresh and never falls back to a task prompt on old backends', async () => {
  const input = { sessionId: 'session', runId: 'run', sourceMessageId: 'message' };
  const extMethod = vi.fn().mockResolvedValue({ event: 'confirmation' });
  vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);
  vi.mocked(getAcpInitializeResponse).mockResolvedValue({
    agentCapabilities: { _meta: { goose: { projectContainers: 1 } } },
  } as never);
  await expect(refreshWorkspaceConfirmation(input)).rejects.toThrow('Update the app and backend');
  expect(extMethod).not.toHaveBeenCalled();
  vi.mocked(getAcpInitializeResponse).mockResolvedValue({
    agentCapabilities: { _meta: { goose: { workspaceConfirmationRefresh: 1 } } },
  } as never);
  await expect(refreshWorkspaceConfirmation(input)).resolves.toEqual({ event: 'confirmation' });
  expect(extMethod).toHaveBeenCalledExactlyOnceWith(
    '_goose/unstable/workspace/confirmation/v1/refresh',
    input
  );
});
