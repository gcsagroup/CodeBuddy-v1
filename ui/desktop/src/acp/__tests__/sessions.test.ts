import type { SessionInfo } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../acpConnection';
import { CodeProWorkspaceReconfirmationRequiredError } from '../../codepro/resumeCodeProSession';
import { AppEvents } from '../../constants/events';
import {
  acpArchiveSession,
  acpForkSession,
  acpGetSessionListItem,
  acpListRecentSessions,
  acpListSessions,
  acpLoadSession,
  acpNewSession,
  acpTruncateSessionConversation,
  acpUnarchiveSession,
  sessionInfoToSession,
} from '../sessions';

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'session-1',
    cwd: '/tmp',
    title: 'Scheduled session',
    updatedAt: '2026-01-01T00:00:00Z',
    _meta: {
      createdAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
      sessionType: 'scheduled',
    },
    ...overrides,
  } as unknown as SessionInfo;
}

describe('ACP sessions', () => {
  it.each([
    [acpArchiveSession, 'sessionArchive_unstable', AppEvents.SESSION_ARCHIVED],
    [acpUnarchiveSession, 'sessionUnarchive_unstable', AppEvents.SESSION_UNARCHIVED],
  ] as const)('refreshes archive views only after %s is confirmed', async (mutate, method, event) => {
    let confirm!: () => void;
    const request = vi.fn().mockReturnValueOnce(new Promise<void>(resolve => { confirm = resolve; }));
    vi.mocked(getAcpClient).mockResolvedValue(
      { goose: { [method]: request } } as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );
    const listener = vi.fn();
    window.addEventListener(event, listener);
    try {
      const pending = mutate('archived-chat');
      await Promise.resolve();
      expect(request).toHaveBeenCalledWith({ sessionId: 'archived-chat' });
      expect(listener).not.toHaveBeenCalled();
      confirm();
      await pending;
      expect(listener).toHaveBeenCalledOnce();
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'archived-chat' });
      request.mockRejectedValueOnce(new Error('Archive update refused'));
      await expect(mutate('archived-chat')).rejects.toThrow('Archive update refused');
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(event, listener);
    }
  });

  it('invalidates child views only after the backend confirms an in-place edit', async () => {
    let confirm!: () => void;
    const truncate = vi.fn().mockReturnValueOnce(
      new Promise<void>((resolve) => {
        confirm = resolve;
      })
    );
    const client = { goose: { sessionConversationTruncate_unstable: truncate } };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );
    const listener = vi.fn();
    window.addEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, listener);
    try {
      const pending = acpTruncateSessionConversation('root', 100);
      await Promise.resolve();
      expect(listener).not.toHaveBeenCalled();
      confirm();
      await pending;
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'root' });
      truncate.mockRejectedValueOnce(new Error('Edit refused'));
      await expect(acpTruncateSessionConversation('root', 100)).rejects.toThrow('Edit refused');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, listener);
    }
  });

  it('passes the requested native preset atomically when creating a session', async () => {
    const client = {
      newSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', modes: { currentModeId: 'read-only' } }),
      setSessionMode: vi.fn(),
      goose: { sessionInfo_unstable: vi.fn().mockResolvedValue({ session: sessionInfo() }) },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );
    const result = await acpNewSession('/tmp', [], { initialPermissionPreset: 'read-only' });
    expect(client.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({ initialPermissionPreset: 'read-only' }),
      })
    );
    expect(result.meta.gooseMode).toBe('read-only');
    expect(client.setSessionMode).not.toHaveBeenCalled();
  });

  it('preserves imported history as a readonly presentation instead of an executable workspace', () => {
    const session = sessionInfoToSession(
      sessionInfo({
        _meta: { readonlyHistory: true, sessionType: 'code_pro' },
      })
    );
    expect(session.extension_data.readonlyHistory).toBe(true);
  });
  it.each(['read-only', 'workspace-write', 'danger-full-access', 'future-mode', undefined])(
    'preserves authoritative mode %s through both new and load responses',
    async (currentModeId) => {
      const response = {
        sessionId: 'session-1',
        ...(currentModeId ? { modes: { currentModeId, availableModes: [] } } : {}),
        _meta: { gooseMode: 'auto' },
      };
      const client = {
        newSession: vi.fn().mockResolvedValue(response),
        loadSession: vi.fn().mockResolvedValue(response),
        goose: {
          sessionInfo_unstable: vi.fn().mockResolvedValue({ session: sessionInfo() }),
        },
      };
      vi.mocked(getAcpClient).mockResolvedValue(
        client as unknown as Awaited<ReturnType<typeof getAcpClient>>
      );
      for (const result of [await acpNewSession('/tmp', []), await acpLoadSession('session-1')]) {
        expect(sessionInfoToSession(result.sessionInfo, result.meta).goose_mode).toBe(
          currentModeId === 'future-mode' ? undefined : currentModeId
        );
      }
    }
  );

  it('preserves a failed capability read and never dispatches fork', async () => {
    const client = {
      goose: {
        sessionInfo_unstable: vi.fn().mockRejectedValue(new Error('Session metadata unavailable')),
      },
      unstable_forkSession: vi.fn(),
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );
    await expect(acpForkSession('session-1')).rejects.toThrow('Session metadata unavailable');
    expect(client.unstable_forkSession).not.toHaveBeenCalled();
  });
  it.each(['code_pro', undefined] as const)(
    'does not send fork for unsupported or unknown type %s',
    async (sessionType) => {
      const client = {
        goose: {
          sessionInfo_unstable: vi.fn().mockResolvedValue({
            session: sessionInfo({ _meta: sessionType ? { sessionType } : {} }),
          }),
        },
        unstable_forkSession: vi.fn(),
      };
      vi.mocked(getAcpClient).mockResolvedValue(
        client as unknown as Awaited<ReturnType<typeof getAcpClient>>
      );
      await expect(acpForkSession('session-1')).rejects.toThrow('cannot be forked');
      expect(client.unstable_forkSession).not.toHaveBeenCalled();
    }
  );

  it('forks a supported session with its actual cwd and requested history boundary', async () => {
    const client = {
      goose: { sessionInfo_unstable: vi.fn().mockResolvedValue({ session: sessionInfo() }) },
      unstable_forkSession: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );
    await expect(acpForkSession('session-1', 42)).resolves.toBe('new-session');
    expect(client.unstable_forkSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/tmp',
      _meta: { conversationBefore: 42 },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves session type from ACP session info metadata', () => {
    const session = sessionInfoToSession(sessionInfo());

    expect(session.session_type).toBe('scheduled');
  });

  it('hides process cwd only for unbound sessions and keeps the root container path visible', () => {
    const unboundSession = sessionInfoToSession(
      sessionInfo({
        cwd: 'C:\\Users\\tester',
        _meta: {
          sessionType: 'code_pro',
          workspaceBinding: 'unbound',
        },
      })
    );
    expect(unboundSession.working_dir).toBe('');
    expect(unboundSession.extension_data).toEqual({
      workspaceBinding: 'unbound',
    });

    const rootContainerSession = sessionInfoToSession(
      sessionInfo({
        cwd: 'D:\\',
        _meta: {
          sessionType: 'code_pro',
          workspaceBinding: 'root_container',
          rootContainerPath: 'D:\\',
        },
      })
    );
    expect(rootContainerSession.working_dir).toBe('D:\\');
    expect(rootContainerSession.extension_data).toEqual({
      workspaceBinding: 'root_container',
      rootContainerPath: 'D:\\',
    });
  });

  it('returns session info refreshed after loading the ACP session', async () => {
    const loadedSessionInfo = sessionInfo({
      _meta: {
        createdAt: '2026-01-01T00:00:00Z',
        messageCount: 0,
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    });
    const client = {
      goose: {
        sessionInfo_unstable: vi
          .fn()
          .mockResolvedValueOnce({ session: sessionInfo() })
          .mockResolvedValueOnce({ session: loadedSessionInfo }),
      },
      loadSession: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const result = await acpLoadSession('session-1');

    expect(client.loadSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/tmp',
      mcpServers: [],
    });
    expect(client.goose.sessionInfo_unstable).toHaveBeenCalledTimes(2);
    expect(result.sessionInfo).toBe(loadedSessionInfo);
    expect(sessionInfoToSession(result.sessionInfo).provider_name).toBe('anthropic');
    expect(sessionInfoToSession(result.sessionInfo).model_config?.model_name).toBe(
      'claude-sonnet-4-5'
    );
  });

  it('passes a fresh workspace lease and authoritative cwd when resuming CodePro', async () => {
    const codeProSession = sessionInfo({
      cwd: 'D:\\CodePro\\Ledger',
      _meta: { sessionType: 'code_pro' },
    });
    const client = {
      goose: {
        sessionInfo_unstable: vi
          .fn()
          .mockResolvedValueOnce({ session: codeProSession })
          .mockResolvedValueOnce({ session: codeProSession }),
      },
      loadSession: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpLoadSession('session-1', {
      cwd: 'D:\\CodePro\\Ledger',
      workspaceLeaseId: 'fresh-lease',
    });

    expect(client.loadSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: 'D:\\CodePro\\Ledger',
      mcpServers: [],
      _meta: { workspaceLeaseId: 'fresh-lease' },
    });
  });

  describe.each(['code_pro', 'scheduled'] as const)('%s workspace recovery', (sessionType) => {
    it.each([
      'CodePro workspace must be re-confirmed before this session can be resumed',
      'invalid directory path',
    ])(
      'turns backend resume rejection %s into a structured workspace reconfirmation request',
      async (reason) => {
        const codeProSession = sessionInfo({
          cwd: 'D:\\CodePro\\Ledger',
          _meta: { sessionType },
        });
        const client = {
          goose: {
            sessionInfo_unstable: vi.fn().mockResolvedValue({ session: codeProSession }),
          },
          loadSession: vi.fn().mockRejectedValue(new Error(reason)),
        };
        vi.mocked(getAcpClient).mockResolvedValue(
          client as unknown as Awaited<ReturnType<typeof getAcpClient>>
        );

        const error = await acpLoadSession('session-1').catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(CodeProWorkspaceReconfirmationRequiredError);
        expect(error).toMatchObject({
          request: { sessionId: 'session-1', workingDir: 'D:\\CodePro\\Ledger' },
        });
      }
    );
  });

  it('returns a list item from ACP session info', async () => {
    const client = {
      goose: {
        sessionInfo_unstable: vi.fn().mockResolvedValue({
          session: sessionInfo({
            title: 'Subagent session',
            _meta: {
              createdAt: '2026-01-01T00:00:00Z',
              lastMessageAt: '2026-01-01T00:01:00Z',
              messageCount: 3,
              sessionType: 'sub_agent',
              workspaceOrigin: 'selected',
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            },
          }),
        }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const item = await acpGetSessionListItem('session-1');

    expect(client.goose.sessionInfo_unstable).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(item).toMatchObject({
      id: 'session-1',
      name: 'Subagent session',
      workspaceOrigin: 'selected',
      workingDir: '/tmp',
      messageCount: 3,
      lastMessageAt: '2026-01-01T00:01:00Z',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('sends the unified type set through paged search and recent list requests', async () => {
    const client = {
      listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpListSessions(
      'cursor-1',
      { keyword: ' old project ', includeArchived: true },
      'unified'
    );
    await acpListRecentSessions(25, 'unified');

    expect(client.listSessions).toHaveBeenNthCalledWith(1, {
      cursor: 'cursor-1',
      _meta: {
        types: ['user', 'scheduled', 'code_pro'],
        query: 'old project',
        includeArchived: true,
      },
    });
    expect(client.listSessions).toHaveBeenNthCalledWith(2, {
      _meta: { types: ['user', 'scheduled', 'code_pro'] },
    });
  });

  it('attaches a confirmed Project ID when creating a CodePro ACP session', async () => {
    const createdSession = sessionInfo({
      cwd: 'D:\\CodeProCp01\\Ledger',
      _meta: { projectId: 'ledger-a1b2c3d4e5f6' },
    });
    const client = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-1', _meta: {} }),
      goose: {
        sessionInfo_unstable: vi.fn().mockResolvedValue({ session: createdSession }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpNewSession('D:\\CodeProCp01\\Ledger', [], {
      workspaceMode: 'codepro',
      projectId: 'ledger-a1b2c3d4e5f6',
      workspaceLeaseId: 'lease-1',
      workspaceBinding: 'writable_project',
      workspaceOrigin: 'selected',
    });

    expect(client.newSession).toHaveBeenCalledWith({
      cwd: 'D:\\CodeProCp01\\Ledger',
      mcpServers: [],
      _meta: {
        client: 'goose-desktop',
        workspaceMode: 'codepro',
        projectId: 'ledger-a1b2c3d4e5f6',
        workspaceLeaseId: 'lease-1',
        workspaceBinding: 'writable_project',
        workspaceOrigin: 'selected',
      },
    });
  });

  it('keeps an unbound process directory out of the visible session list', async () => {
    const client = {
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          sessionInfo({
            cwd: 'C:\\host-process',
            _meta: { workspaceBinding: 'unbound', sessionType: 'code_pro' },
          }),
        ],
      }),
    };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    const result = await acpListSessions(undefined, undefined, 'codepro');
    expect(result.sessions[0]).toMatchObject({ workingDir: '', workspaceBinding: 'unbound' });
  });

  it('persists unbound and root-container bindings across ACP new_session', async () => {
    const client = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-1', _meta: {} }),
      goose: { sessionInfo_unstable: vi.fn().mockResolvedValue({ session: sessionInfo() }) },
    };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);

    await acpNewSession('C:\\Users\\tester', [], {
      workspaceMode: 'codepro',
      workspaceBinding: 'unbound',
    });
    await acpNewSession('D:\\', [], {
      workspaceMode: 'codepro',
      workspaceBinding: 'root_container',
      rootContainerPath: 'D:\\',
    });

    expect(client.newSession).toHaveBeenNthCalledWith(1, {
      cwd: 'C:\\Users\\tester',
      mcpServers: [],
      _meta: {
        client: 'goose-desktop',
        workspaceMode: 'codepro',
        workspaceBinding: 'unbound',
      },
    });
    expect(client.newSession).toHaveBeenNthCalledWith(2, {
      cwd: 'D:\\',
      mcpServers: [],
      _meta: {
        client: 'goose-desktop',
        workspaceMode: 'codepro',
        workspaceBinding: 'root_container',
        rootContainerPath: 'D:\\',
      },
    });
  });
});

it('preserves project-container metadata without promoting it to a writable project', () => {
  const session = sessionInfoToSession(
    sessionInfo({
      cwd: '/Users/test/Projects',
      _meta: { sessionType: 'code_pro', workspaceBinding: 'project_container' },
    })
  );
  expect(session.working_dir).toBe('/Users/test/Projects');
  expect(session.extension_data.workspaceBinding).toBe('project_container');
});
