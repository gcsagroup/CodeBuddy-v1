import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleModal } from '../ScheduleModal';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { parseDeeplink } from '../../../recipe';

vi.mock('../../../recipe', () => ({
  parseDeeplink: vi.fn(),
  parseRecipeFromFile: vi.fn(),
}));
vi.mock('../../../recipe/recipe_management', () => ({ getStorageDirectory: vi.fn() }));

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

describe('ScheduleModal recipe names', () => {
  beforeEach(() => {
    vi.mocked(parseDeeplink).mockResolvedValue({
      version: '1.0.0',
      title: '夜间验收',
      description: 'fixture',
      prompt: 'hello',
    });
  });

  function open() {
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink={null}
        workspaceMode="codepro"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: 'Deep link' }));
  }

  it('preserves a name entered before parsing a recipe', async () => {
    open();
    const name = screen.getByPlaceholderText('e.g., daily-summary-job');
    fireEvent.change(name, { target: { value: 'my-nightly-job' } });
    fireEvent.change(screen.getByPlaceholderText('Paste codebuddy://recipe link here...'), {
      target: { value: 'codebuddy://recipe?config=fixture' },
    });
    await screen.findByText('Recipe parsed successfully', { exact: false });
    expect(name).toHaveValue('my-nightly-job');
  });

  it('keeps a Chinese recipe title meaningful when suggesting an empty name', async () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('Paste codebuddy://recipe link here...'), {
      target: { value: 'codebuddy://recipe?config=fixture' },
    });
    await waitFor(() =>
      expect(screen.getByPlaceholderText('e.g., daily-summary-job')).toHaveValue('夜间验收')
    );
  });
});

describe('automatic task destinations', () => {
  it('retains instructions and name when a failed test reopens the hidden form', async () => {
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
    fireEvent.change(screen.getByPlaceholderText('e.g., daily-summary-job'), {
      target: { value: 'Retry task' },
    });
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
    expect(screen.getByPlaceholderText('e.g., daily-summary-job')).toHaveValue('Retry task');
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'Retry task',
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
    fireEvent.change(screen.getByPlaceholderText('e.g., daily-summary-job'), {
      target: { value: 'Daily report' },
    });
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
    fireEvent.click(screen.getByRole('switch', { name: 'A new chat each time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test & Enable' }));
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionMode: 'current_session',
          targetSessionId: 'existing-chat',
        })
      )
    );
    expect(screen.getByRole('button', { name: 'YAML' })).toBeDisabled();
  });

  it('does not offer current-chat binding without an actual chat', () => {
    render(
      <ScheduleModal
        isOpen
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        schedule={null}
        isLoadingExternally={false}
        apiErrorExternally={null}
        initialDeepLink={null}
        workspaceMode="codepro"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByRole('switch', { name: 'A new chat each time' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'A new chat each time' })).toBeChecked();
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
