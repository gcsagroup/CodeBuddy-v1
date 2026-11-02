import userEvent from '@testing-library/user-event';
import { acpListSessions } from '../../../acp/sessions';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleModal } from '../ScheduleModal';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { parseDeeplink } from '../../../recipe';

vi.mock('../ScheduleModelControls', () => ({
  ScheduleModelControls: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          goose_provider: 'fixture-provider',
          goose_model: 'fixture-model',
          goose_thinking_effort: 'high',
        })
      }
    >
      Choose task model
    </button>
  ),
}));

vi.mock('../../../acp/sessions', () => ({ acpListSessions: vi.fn() }));

vi.mock('../../../recipe', () => ({
  parseDeeplink: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

describe('ScheduleModal imported recipes', () => {
  const recipe = {
    version: '1.0.0',
    title: '夜间验收',
    description: 'fixture',
    prompt: 'hello',
  };

  function open(onSubmit = vi.fn()) {
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={onSubmit}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink="codebuddy://recipe?config=fixture"
        workspaceMode="codepro"
      />,
      { wrapper: IntlTestWrapper }
    );
  }

  it('waits for an existing library link to finish loading before allowing creation', async () => {
    let finishParsing!: (value: typeof recipe) => void;
    vi.mocked(parseDeeplink).mockReturnValueOnce(
      new Promise((resolve) => {
        finishParsing = resolve;
      })
    );
    open();
    expect(screen.getByRole('button', { name: 'Test & Enable' })).toBeDisabled();
    finishParsing(recipe);
    await screen.findByText('Recipe parsed successfully', { exact: false });
    expect(screen.getByRole('button', { name: 'Test & Enable' })).toBeEnabled();
  });

  it('still schedules a recipe passed by the existing library entry without source controls', async () => {
    vi.mocked(parseDeeplink).mockResolvedValueOnce(recipe);
    const submit = vi.fn().mockResolvedValue(undefined);
    open(submit);
    await screen.findByText('Recipe parsed successfully', { exact: false });
    expect(screen.queryByText('More settings')).not.toBeInTheDocument();
    expect(screen.queryByText('Source:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'YAML' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: '夜间验收', recipe }))
    );
  });
});

describe('automatic task destinations', () => {
  it('retains instructions and the generated name when a failed test reopens the form', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const props = {
      onClose: vi.fn(),
      onSubmit: submit,
      schedule: null,
      initialDeepLink: null,
      workspaceMode: 'codepro' as const,
    };
    const { rerender } = render(
      <ScheduleModal {...props} isOpen isLoadingExternally={false} apiErrorExternally={null} />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), {
      target: { value: 'Retain this task.' },
    });
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.queryByText('More settings')).not.toBeInTheDocument();
    expect(screen.queryByText('Source:')).not.toBeInTheDocument();
    rerender(
      <ScheduleModal {...props} isOpen={false} isLoadingExternally apiErrorExternally={null} />
    );
    rerender(
      <ScheduleModal
        {...props}
        isOpen
        isLoadingExternally={false}
        apiErrorExternally="test rejected"
      />
    );
    expect(screen.getByRole('textbox', { name: 'Task instructions' })).toHaveValue(
      'Retain this task.'
    );
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.queryByRole('textbox', { name: 'Name:' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'Retain this task.',
          recipe: expect.objectContaining({ prompt: 'Retain this task.' }),
        })
      )
    );
  });

  it('submits plain instructions in a new chat by default, or binds the displayed current chat', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={submit}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink={null}
        workspaceMode="codepro"
        currentChat={{ id: 'existing-chat', name: 'Test progress' }}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), {
      target: { value: 'Summarize findings.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          executionMode: 'new_session',
          recipe: expect.objectContaining({
            prompt: 'Summarize findings.',
            description: expect.stringMatching(/\S/u),
          }),
        })
      )
    );
    expect(submit.mock.calls[0][0]).not.toHaveProperty('targetSessionId');
    fireEvent.click(screen.getByRole('switch', { name: 'Open a new chat on every run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionMode: 'current_session',
          targetSessionId: 'existing-chat',
        })
      )
    );
    expect(screen.queryByText('Source:')).not.toBeInTheDocument();
  });

  it('keeps a selected model and effort local to new-chat tasks and drops the override for follow-ups', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={submit}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink={null}
        workspaceMode="codepro"
        currentChat={{ id: 'existing-chat', name: 'Review' }}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), {
      target: { value: 'Run the tests.' },
    });
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose task model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recipe: expect.objectContaining({
            settings: {
              goose_provider: 'fixture-provider',
              goose_model: 'fixture-model',
              goose_thinking_effort: 'high',
            },
          }),
        })
      )
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Open a new chat on every run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({ executionMode: 'current_session' })
      )
    );
    expect(submit.mock.calls[submit.mock.calls.length - 1]?.[0].recipe).not.toHaveProperty(
      'settings'
    );
  });

  it('lets a standalone task choose a real chat before enabling follow-up', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(acpListSessions).mockResolvedValue({
      sessions: [
        {
          id: 'chosen-chat',
          name: 'Existing review',
          workingDir: '/fixture',
          createdAt: '',
          updatedAt: '',
          messageCount: 1,
        },
      ],
      nextCursor: null,
    });
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={submit}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink={null}
        workspaceMode="codepro"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), {
      target: { value: 'Follow the build.' },
    });
    await user.click(screen.getByText('Advanced'));
    const toggle = screen.getByRole('switch', { name: 'Open a new chat on every run' });
    expect(toggle).toBeEnabled();
    expect(acpListSessions).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Test & Enable' })).toBeDisabled();
    expect(screen.getByText('Choose a chat for this follow-up.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Follow-up chat' }));
    await user.click(await screen.findByRole('button', { name: 'Existing review' }));
    await user.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionMode: 'current_session',
          targetSessionId: 'chosen-chat',
        })
      )
    );
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({ executionMode: 'new_session' })
      )
    );
    expect(submit.mock.calls[submit.mock.calls.length - 1][0]).not.toHaveProperty(
      'targetSessionId'
    );
  });

  it('creates a plain task without requiring hidden advanced fields', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={submit}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink={null}
        workspaceMode="codepro"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), {
      target: { value: 'Daily summary\nSummarize the latest findings.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'Daily summary',
          executionMode: 'new_session',
          paused: true,
          tested: false,
          recipe: expect.objectContaining({
            prompt: 'Daily summary\nSummarize the latest findings.',
            description: expect.stringMatching(/\S/u),
          }),
        })
      )
    );
  });
});
