import { ProjectContainerUpgradeRequiredError } from '../../acp/workspaceLease';
import type { ReactElement } from 'react';
import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppEvents } from '../../constants/events';
import {
  findNeedsWorkspaceSourceMessage,
  NeedsWorkspaceInline,
  NeedsWorkspacePrompt,
  parseNeedsWorkspaceEvent,
} from './NeedsWorkspaceInline';
import { IntlTestWrapper } from '../../i18n/test-utils';

const render = (ui: ReactElement) => testingRender(ui, { wrapper: IntlTestWrapper });

const mocks = vi.hoisted(() => ({
  allocateWorkspaceChild: vi.fn(),
  allocateProjectChild: vi.fn(),
  refreshWorkspaceConfirmation: vi.fn(),
  bindAllocatedCodeProSession: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../acp/workspaceLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acp/workspaceLease')>()),
  allocateWorkspaceChild: mocks.allocateWorkspaceChild,
  allocateProjectChild: mocks.allocateProjectChild,
  refreshWorkspaceConfirmation: mocks.refreshWorkspaceConfirmation,
}));
vi.mock('../../codepro/resumeCodeProSession', () => ({
  bindAllocatedCodeProSession: mocks.bindAllocatedCodeProSession,
}));
vi.mock('../ConfigContext', () => ({
  useConfig: () => ({ extensionsList: [] }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

const event = {
  event: 'codepro.needs_workspace' as const,
  rootContainerPath: 'D:\\',
  suggestedChildName: 'invoice-parser',
  writableRoot: null,
  capability: {
    sessionId: 'session-1',
    runId: 'run-1',
    sourceMessageId: 'message-1',
    nonce: 'nonce-1',
  },
};

const lease = {
  leaseId: 'lease-1',
  workingDir: 'D:\\invoice-parser',
  normalizedIdentity: 'd:\\invoice-parser',
  created: true,
};

const retryablePermissionData = {
  code: 'workspace_permission_denied',
  retryable: true,
  capabilityPreserved: true,
};

beforeEach(() => {
  mocks.allocateWorkspaceChild.mockReset();
  mocks.allocateProjectChild.mockReset();
  mocks.refreshWorkspaceConfirmation.mockReset();
  mocks.bindAllocatedCodeProSession.mockReset();
  mocks.navigate.mockReset();
  mocks.allocateWorkspaceChild.mockResolvedValue(lease);
  mocks.bindAllocatedCodeProSession.mockResolvedValue({ workingDir: lease.workingDir });
});

describe('NeedsWorkspacePrompt', () => {
  it('does not allocate until explicit confirmation and submits at most once', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<NeedsWorkspacePrompt event={event} onConfirm={onConfirm} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
    fireEvent.click(screen.getByRole('button', { name: /Creating|Created/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('cancels without allocation or mutation', () => {
    const onConfirm = vi.fn();
    render(<NeedsWorkspacePrompt event={event} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/No directory was created/)).toBeInTheDocument();
  });

  it('fails closed on malformed backend events', () => {
    for (const suggestedChildName of ['创建示例项目', '库存管理系统', '发票解析器']) {
      expect(parseNeedsWorkspaceEvent({ ...event, suggestedChildName })).not.toBeNull();
    }
    for (const suggestedChildName of ['../escape', '库存/管理', 'name_underscore', 'CON']) {
      expect(parseNeedsWorkspaceEvent({ ...event, suggestedChildName })).toBeNull();
    }
    expect(parseNeedsWorkspaceEvent({ ...event, writableRoot: 'D:\\' })).toBeNull();
    expect(parseNeedsWorkspaceEvent({ ...event, capability: undefined })).toBeNull();
  });

  it('allocates, binds, and resumes in the same conversation without creating a new session', async () => {
    const sequence: string[] = [];
    mocks.allocateWorkspaceChild.mockImplementation(async () => {
      sequence.push('allocate');
      return lease;
    });
    mocks.bindAllocatedCodeProSession.mockImplementation(async () => {
      sequence.push('bind');
      return { workingDir: lease.workingDir };
    });
    mocks.navigate.mockImplementation(() => {
      sequence.push('navigate');
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const onResumeAfterWorkspace = vi.fn(async () => {
      sequence.push('resume');
    });
    const originalMessage = {
      id: 'message-1',
      role: 'user' as const,
      created: 123,
      content: [
        { type: 'text' as const, text: 'create the invoice parser' },
        { type: 'image' as const, data: 'base64-image', mimeType: 'image/png' },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };

    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
        originalMessage={originalMessage}
        onResumeAfterWorkspace={onResumeAfterWorkspace}
      />
    );

    expect(
      screen.queryByText(
        'Creating a safe project folder here, then continuing in this conversation.'
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledTimes(1));
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledTimes(1);
    expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      lease,
    });
    expect(onResumeAfterWorkspace).toHaveBeenCalledWith(originalMessage, 'run-1');
    expect(sequence).toEqual(['allocate', 'bind', 'resume']);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: AppEvents.SESSION_CREATED })
    );
    expect(await screen.findByText(/D:\\invoice-parser/)).toBeVisible();
    dispatch.mockRestore();
  });

  it('coalesces duplicate workspace notifications into one allocation and continuation', async () => {
    const firstResume = vi.fn().mockResolvedValue(undefined);
    const secondResume = vi.fn().mockResolvedValue(undefined);
    const originalMessage = {
      id: 'message-1',
      role: 'user' as const,
      created: 123,
      content: [{ type: 'text' as const, text: 'create the invoice parser' }],
      metadata: { userVisible: true, agentVisible: true },
    };

    render(
      <>
        <NeedsWorkspaceInline
          notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
          originalMessage={originalMessage}
          onResumeAfterWorkspace={firstResume}
        />
        <NeedsWorkspaceInline
          notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
          originalMessage={originalMessage}
          onResumeAfterWorkspace={secondResume}
        />
      </>
    );

    await waitFor(() =>
      expect(firstResume.mock.calls.length + secondResume.mock.calls.length).toBe(1)
    );
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledOnce();
    expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledOnce();
  });

  it('coalesces duplicate notifications when replay recreates the source message object', async () => {
    const firstResume = vi.fn().mockResolvedValue(undefined);
    const secondResume = vi.fn().mockResolvedValue(undefined);
    const sourceMessage = {
      id: 'message-1',
      role: 'user' as const,
      created: 123,
      content: [{ type: 'text' as const, text: 'create the invoice parser' }],
      metadata: { userVisible: true, agentVisible: true },
    };

    render(
      <>
        <NeedsWorkspaceInline
          notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
          originalMessage={sourceMessage}
          onResumeAfterWorkspace={firstResume}
        />
        <NeedsWorkspaceInline
          notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
          originalMessage={{ ...sourceMessage }}
          onResumeAfterWorkspace={secondResume}
        />
      </>
    );

    await waitFor(() =>
      expect(firstResume.mock.calls.length + secondResume.mock.calls.length).toBe(1)
    );
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledOnce();
    expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledOnce();
  });

  it('allocates immediately after the user chooses an unbound root', async () => {
    Object.assign(window, {
      electron: {
        directoryChooser: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['D:\\'] }),
      },
    });

    render(
      <NeedsWorkspaceInline
        notification={
          {
            notificationType: 'inlineMessage',
            msg: '',
            data: { ...event, rootContainerPath: null },
          } as never
        }
        originalMessage={{ msg: 'create the invoice parser', images: [] }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose root container' }));
    await screen.findByText('Project created at D:\\invoice-parser. Continuing here now.');
    await waitFor(() => expect(mocks.allocateWorkspaceChild).toHaveBeenCalledOnce());
  });

  it('retries continuation without creating or binding a second project', async () => {
    const onResumeAfterWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary continuation failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
        originalMessage={{ id: 'message-1', role: 'user', content: [] } as never}
        onResumeAfterWorkspace={onResumeAfterWorkspace}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The project was created at D:\\invoice-parser, but continuing was interrupted.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Project created at D:\\invoice-parser. Continuing here now.');
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledOnce();
    expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledOnce();
    expect(onResumeAfterWorkspace).toHaveBeenCalledTimes(2);
  });

  it('keeps root selection retryable after the chooser is cancelled', async () => {
    const directoryChooser = vi
      .fn()
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['D:\\'] });
    Object.assign(window, { electron: { directoryChooser } });

    render(
      <NeedsWorkspaceInline
        notification={
          {
            notificationType: 'inlineMessage',
            msg: '',
            data: { ...event, rootContainerPath: null },
          } as never
        }
        originalMessage={{ msg: 'create the invoice parser', images: [] }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose root container' }));
    expect(await screen.findByRole('button', { name: 'Choose root container' })).toBeEnabled();
    expect(mocks.allocateWorkspaceChild).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Choose root container' }));
    expect(
      await screen.findByText('Project created at D:\\invoice-parser. Continuing here now.')
    ).toBeVisible();
    expect(directoryChooser).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mocks.allocateWorkspaceChild).toHaveBeenCalledOnce());
  });

  it('keeps chooser errors path-free and retryable', async () => {
    const directoryChooser = vi
      .fn()
      .mockRejectedValueOnce(new Error('Access denied at C:\\Users\\secret\\project'))
      .mockResolvedValueOnce({ canceled: false, filePaths: ['D:\\'] });
    Object.assign(window, { electron: { directoryChooser } });

    render(
      <NeedsWorkspaceInline
        notification={
          {
            notificationType: 'inlineMessage',
            msg: '',
            data: { ...event, rootContainerPath: null },
          } as never
        }
        originalMessage={{ msg: 'create the invoice parser', images: [] }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose root container' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to choose a filesystem root. Try again.');
    expect(alert).not.toHaveTextContent('secret');

    fireEvent.click(screen.getByRole('button', { name: 'Choose root container' }));
    expect(
      await screen.findByText('Project created at D:\\invoice-parser. Continuing here now.')
    ).toBeVisible();
    expect(directoryChooser).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'nested ACP data',
      Object.assign(new Error('Invalid params'), { error: { data: retryablePermissionData } }),
    ],
    [
      'direct ACP data',
      Object.assign(new Error('Invalid params'), { data: retryablePermissionData }),
    ],
  ])(
    'retries with the same capability only for typed permission errors in %s',
    async (_label, reason) => {
      mocks.allocateWorkspaceChild.mockRejectedValueOnce(reason).mockResolvedValueOnce(lease);

      render(
        <NeedsWorkspaceInline
          notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
          originalMessage={{ msg: 'create the invoice parser', images: [] }}
        />
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Workspace access was denied. Retry to use the same authorization.'
      );
      expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledOnce());
      expect(mocks.allocateWorkspaceChild).toHaveBeenCalledTimes(2);
      expect(mocks.allocateWorkspaceChild.mock.calls[0][0].capability).toBe(event.capability);
      expect(mocks.allocateWorkspaceChild.mock.calls[1][0].capability).toBe(event.capability);
    }
  );

  it.each([
    ['generic error', new Error('Access denied at C:\\Users\\secret\\project')],
    ['wrong code', { data: { ...retryablePermissionData, code: 'other' } }],
    ['not retryable', { data: { ...retryablePermissionData, retryable: false } }],
    ['capability consumed', { data: { ...retryablePermissionData, capabilityPreserved: false } }],
    [
      'conflicting nested envelope',
      {
        error: { data: { ...retryablePermissionData, code: 'other' } },
        data: retryablePermissionData,
      },
    ],
    ['nested envelope with missing data', { error: {}, data: retryablePermissionData }],
    ['nested envelope with null data', { error: { data: null }, data: retryablePermissionData }],
    ['inherited error envelope', Object.create({ error: { data: retryablePermissionData } })],
    ['inherited direct data', Object.create({ data: retryablePermissionData })],
    ['inherited permission fields', { data: Object.create(retryablePermissionData) }],
    [
      'missing retryable flag',
      {
        error: {
          data: {
            code: retryablePermissionData.code,
            capabilityPreserved: true,
          },
        },
      },
    ],
    [
      'null capability flag',
      { error: { data: { ...retryablePermissionData, capabilityPreserved: null } } },
    ],
    [
      'string retryable flag',
      { error: { data: { ...retryablePermissionData, retryable: 'true' } } },
    ],
    [
      'number capability flag',
      { error: { data: { ...retryablePermissionData, capabilityPreserved: 1 } } },
    ],
  ])('does not retry non-authorized allocation failures: %s', async (_label, reason) => {
    mocks.allocateWorkspaceChild.mockRejectedValue(reason);

    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
        originalMessage={{ msg: 'create the invoice parser', images: [] }}
      />
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Workspace setup failed. The project state is unknown and may require manual review.'
    );
    expect(alert).not.toHaveTextContent('No directory was created');
    expect(alert).not.toHaveTextContent('secret');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledTimes(1);
    expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('uses a conservative path-free message when current-session binding may leave state uncertain', async () => {
    mocks.bindAllocatedCodeProSession.mockRejectedValue(
      new Error('rollback left an orphan at D:\\private\\invoice-parser')
    );

    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
        originalMessage={{ msg: 'create the invoice parser', images: [] }}
      />
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Workspace setup failed. The project state is unknown and may require manual review.'
    );
    expect(alert).not.toHaveTextContent('No directory was created');
    expect(alert).not.toHaveTextContent('private');
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledOnce();
    expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('binds re-submission to the backend sourceMessageId instead of the nearest user message', () => {
    const messages = [
      { id: 'message-1', role: 'user', content: [] },
      { id: 'message-2', role: 'user', content: [] },
    ] as never;

    expect(findNeedsWorkspaceSourceMessage(messages, 2, event)?.id).toBe('message-1');
  });

  it('uses the backend source id when ACP rewrites the current turn message id', () => {
    const messages = [
      { id: 'client-message-1', role: 'user', content: [] },
      { id: 'assistant-progress', role: 'assistant', content: [] },
    ] as never;

    expect(findNeedsWorkspaceSourceMessage(messages, 2, event)).toEqual(
      expect.objectContaining({ id: 'message-1', role: 'user' })
    );
  });
});

describe('Mac project parent confirmation', () => {
  it('retries a denied parent with the same confirmed capability before binding', async () => {
    const parent = '/Users/test/Projects';
    const child = parent + '/invoice-parser';
    mocks.allocateProjectChild
      .mockRejectedValueOnce(
        Object.assign(new Error('Invalid params'), {
          data: retryablePermissionData,
        })
      )
      .mockResolvedValueOnce({ ...lease, workingDir: child, normalizedIdentity: child });
    mocks.bindAllocatedCodeProSession.mockResolvedValue({ workingDir: child });
    const resume = vi.fn();
    render(
      <NeedsWorkspaceInline
        notification={
          {
            notificationType: 'inlineMessage',
            msg: '',
            data: {
              ...event,
              event: 'codepro.needs_project_workspace_v1',
              rootContainerPath: parent,
            },
          } as never
        }
        originalMessage={{ id: 'message-1', role: 'user', content: [] } as never}
        onResumeAfterWorkspace={resume}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace access was denied');
    expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(mocks.allocateProjectChild).toHaveBeenCalledTimes(2);
    expect(mocks.allocateProjectChild.mock.calls[1]).toEqual(
      mocks.allocateProjectChild.mock.calls[0]
    );
    expect(mocks.allocateWorkspaceChild).not.toHaveBeenCalled();
  });

  it('uses the canonical parent, waits for confirmation and continues the same source message', async () => {
    const parent = '/Users/test/中文 Projects';
    const child = parent + '/invoice-parser';
    const macEvent = {
      ...event,
      event: 'codepro.needs_project_workspace_v1',
      rootContainerPath: null,
    };
    Object.assign(window, {
      electron: {
        directoryChooser: vi
          .fn()
          .mockResolvedValue({ canceled: false, filePaths: ['/Users/test/alias'] }),
        inspectCodeProWorkspace: vi
          .fn()
          .mockResolvedValue([{ canonicalPath: parent, state: 'non-empty-directory' }]),
      },
    });
    mocks.allocateProjectChild.mockResolvedValue({
      ...lease,
      workingDir: child,
      normalizedIdentity: child,
    });
    mocks.bindAllocatedCodeProSession.mockResolvedValue({ workingDir: child });
    const message = { id: 'message-1', role: 'user' as const, content: [] };
    const resume = vi.fn();
    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: macEvent } as never}
        originalMessage={message as never}
        onResumeAfterWorkspace={resume}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose project parent folder' }));
    expect(await screen.findByText(child)).toBeVisible();
    expect(mocks.allocateProjectChild).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith(message, 'run-1'));
    expect(mocks.allocateProjectChild).toHaveBeenCalledWith({
      containerPath: parent,
      suggestedName: 'invoice-parser',
      capability: event.capability,
    });
    expect(mocks.allocateWorkspaceChild).not.toHaveBeenCalled();
    expect(mocks.bindAllocatedCodeProSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      lease: expect.objectContaining({ workingDir: child }),
    });
  });

  it('requires confirmation again for a persisted project container and supports cancellation', async () => {
    render(
      <NeedsWorkspaceInline
        notification={
          {
            notificationType: 'inlineMessage',
            msg: '',
            data: {
              ...event,
              event: 'codepro.needs_project_workspace_v1',
              rootContainerPath: '/Users/test/Projects',
            },
          } as never
        }
        originalMessage={{ msg: 'create', images: [] }}
      />
    );
    expect(mocks.allocateProjectChild).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/No directory was created/)).toBeVisible();
    expect(mocks.allocateProjectChild).not.toHaveBeenCalled();
  });

  it('rejects a filesystem root or missing parent before allocation', async () => {
    Object.assign(window, {
      electron: {
        directoryChooser: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/'] }),
        inspectCodeProWorkspace: vi
          .fn()
          .mockResolvedValue([{ canonicalPath: '/', state: 'empty-directory' }]),
      },
    });
    render(
      <NeedsWorkspaceInline
        notification={
          {
            notificationType: 'inlineMessage',
            msg: '',
            data: {
              ...event,
              event: 'codepro.needs_project_workspace_v1',
              rootContainerPath: null,
            },
          } as never
        }
        originalMessage={{ msg: 'create', images: [] }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose project parent folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not inspect');
    expect(mocks.allocateProjectChild).not.toHaveBeenCalled();
  });
});

it('shows an upgrade action for an unsupported project-container backend', async () => {
  mocks.allocateProjectChild.mockRejectedValue(new ProjectContainerUpgradeRequiredError());
  render(
    <NeedsWorkspaceInline
      notification={
        {
          notificationType: 'inlineMessage',
          msg: '',
          data: {
            ...event,
            event: 'codepro.needs_project_workspace_v1',
            rootContainerPath: '/Users/test/Projects',
          },
        } as never
      }
      originalMessage={{ msg: 'create', images: [] }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Update the app and backend together');
  expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();
});

describe('expired project confirmation refresh', () => {
  const macEvent = {
    ...event,
    event: 'codepro.needs_project_workspace_v1' as const,
    rootContainerPath: '/Users/test/中文 项目',
  };
  const message = { id: 'message-1', role: 'user' as const, content: [] };
  it('refreshes only the original task and waits for a second explicit confirmation', async () => {
    const resume = vi.fn();
    const next = { ...macEvent, capability: { ...event.capability, nonce: 'fresh-nonce' } };
    mocks.allocateProjectChild
      .mockRejectedValueOnce(new Error('expired'))
      .mockResolvedValueOnce({ ...lease, workingDir: '/Users/test/中文 项目/invoice-parser' });
    mocks.refreshWorkspaceConfirmation.mockResolvedValue(next);
    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: macEvent } as never}
        originalMessage={message as never}
        onResumeAfterWorkspace={resume}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project confirmation' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm project' })).toBeEnabled()
    );
    expect(mocks.refreshWorkspaceConfirmation).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      sourceMessageId: 'message-1',
    });
    expect(mocks.allocateProjectChild).toHaveBeenCalledTimes(1);
    expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm project' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith(message, 'run-1'));
    expect(mocks.allocateProjectChild).toHaveBeenLastCalledWith({
      containerPath: macEvent.rootContainerPath,
      suggestedName: macEvent.suggestedChildName,
      capability: next.capability,
    });
  });
  it('rejects a mismatched refreshed run without creating or continuing', async () => {
    mocks.refreshWorkspaceConfirmation.mockResolvedValue({
      ...macEvent,
      capability: { ...event.capability, runId: 'other-run' },
    });
    const resume = vi.fn();
    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: macEvent } as never}
        originalMessage={message as never}
        onResumeAfterWorkspace={resume}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project confirmation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not renew');
    expect(mocks.allocateProjectChild).not.toHaveBeenCalled();
    expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation after refreshing an automatic Windows card', async () => {
    mocks.allocateWorkspaceChild.mockRejectedValueOnce(new Error('expired'));
    mocks.refreshWorkspaceConfirmation.mockResolvedValue({
      ...event,
      capability: { ...event.capability, nonce: 'fresh-windows' },
    });
    render(
      <NeedsWorkspaceInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: event } as never}
        originalMessage={message as never}
      />
    );
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project confirmation' }));
    expect(await screen.findByRole('button', { name: 'Confirm project' })).toBeEnabled();
    expect(mocks.allocateWorkspaceChild).toHaveBeenCalledTimes(1);
    expect(mocks.bindAllocatedCodeProSession).not.toHaveBeenCalled();
  });
});
