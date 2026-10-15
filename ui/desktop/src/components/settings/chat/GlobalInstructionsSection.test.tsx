import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { GlobalInstructionsSection } from './GlobalInstructionsSection';

describe('GlobalInstructionsSection', () => {
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const getAppConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getAppConfig.mockImplementation((key: string) =>
      key === 'CODEBUDDY_HOME' ? 'C:/Users/tester/.CodeBuddy' : undefined
    );
    readFile.mockResolvedValue({ file: '', error: '', found: false });
    writeFile.mockResolvedValue(true);
    Object.assign(window, {
      appConfig: {
        get: getAppConfig,
        getAll: vi.fn(),
      },
    });
    Object.assign(window.electron, { readFile, writeFile });
  });

  const renderSection = () =>
    render(<GlobalInstructionsSection />, {
      wrapper: IntlTestWrapper,
    });

  it('creates the global AGENTS.md under CODEBUDDY_HOME', async () => {
    renderSection();

    const editor = await screen.findByPlaceholderText('Enter your global rules here...');
    fireEvent.change(editor, { target: { value: 'Always explain risky changes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith(
        'C:/Users/tester/.CodeBuddy/AGENTS.md',
        'Always explain risky changes.'
      )
    );
    expect(await screen.findByText('Saved successfully')).toBeInTheDocument();
  });

  it('loads an existing global AGENTS.md', async () => {
    readFile.mockImplementation(async (path: string) =>
      path.endsWith('/AGENTS.md')
        ? { file: 'Use concise Chinese.', error: '', found: true }
        : { file: '', error: '', found: false }
    );

    renderSection();

    expect(await screen.findByPlaceholderText('Enter your global rules here...')).toHaveValue(
      'Use concise Chinese.'
    );
    expect(readFile).toHaveBeenCalledWith('C:/Users/tester/.CodeBuddy/AGENTS.override.md');
    expect(readFile).toHaveBeenCalledWith('C:/Users/tester/.CodeBuddy/AGENTS.md');
  });

  it('fails closed when CODEBUDDY_HOME is unavailable', () => {
    getAppConfig.mockReturnValue(undefined);

    renderSection();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The CodeBuddy home directory is unavailable.'
    );
    expect(readFile).not.toHaveBeenCalled();
  });
});
