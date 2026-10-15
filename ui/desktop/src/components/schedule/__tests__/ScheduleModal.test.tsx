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
