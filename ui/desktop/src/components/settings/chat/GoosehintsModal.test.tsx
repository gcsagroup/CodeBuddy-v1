import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { GoosehintsModal } from './GoosehintsModal';

describe('GoosehintsModal save result handling', () => {
  const readFile = vi.fn();
  const writeFile = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    readFile.mockImplementation(async (path: string) =>
      path.endsWith('/AGENTS.md')
        ? { file: 'original instructions', error: '', found: true }
        : { file: '', error: '', found: false }
    );
    Object.assign(window.electron, { readFile, writeFile });
  });

  const renderModalWithDraft = async () => {
    render(<GoosehintsModal directory="D:/workspace" setIsGoosehintsModalOpen={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });
    const editor = await screen.findByPlaceholderText('Enter project instructions here...');
    fireEvent.change(editor, { target: { value: 'unsaved draft' } });
    return editor;
  };

  it('treats a false write result as failure and preserves the draft', async () => {
    writeFile.mockResolvedValue(false);
    const editor = await renderModalWithDraft();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save AGENTS.md file');
    expect(editor).toHaveValue('unsaved draft');
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
    expect(writeFile).toHaveBeenCalledWith('D:/workspace/AGENTS.md', 'unsaved draft');
  });

  it('handles a rejected write without leaking its absolute path', async () => {
    const privatePath = 'C:\\Users\\Alice\\Secret\\AGENTS.md';
    writeFile.mockRejectedValue(new Error(`EACCES: ${privatePath}`));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const editor = await renderModalWithDraft();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save AGENTS.md file');
    expect(editor).toHaveValue('unsaved draft');
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(privatePath);
    await waitFor(() => {
      expect(
        JSON.stringify([
          ...consoleError.mock.calls,
          ...consoleWarn.mock.calls,
          ...consoleLog.mock.calls,
        ])
      ).not.toContain(privatePath);
    });
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  it('keeps the draft and refuses to overwrite an externally changed AGENTS.md', async () => {
    const editor = await renderModalWithDraft();
    readFile.mockResolvedValue({
      file: 'instructions changed by another process',
      error: '',
      found: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AGENTS.md changed before the save check. Reload before saving to avoid overwriting that newer version.'
    );
    expect(editor).toHaveValue('unsaved draft');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('shows success only when the write result is true', async () => {
    writeFile.mockResolvedValue(true);
    const editor = await renderModalWithDraft();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved successfully')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(editor).toHaveValue('unsaved draft');
  });

  it('allows creating AGENTS.md when missing files are reported as ENOENT', async () => {
    readFile.mockResolvedValue({
      file: '',
      error: "Error: ENOENT: no such file or directory, open 'D:/workspace/missing'",
      found: false,
    });

    render(<GoosehintsModal directory="D:/workspace" setIsGoosehintsModalOpen={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    expect(await screen.findByPlaceholderText('Enter project instructions here...')).toBeVisible();
    expect(screen.queryByText(/ENOENT/)).not.toBeInTheDocument();
    expect(
      screen.getByText('A new AGENTS.md will be created at: D:/workspace/AGENTS.md')
    ).toBeInTheDocument();
  });

  it('offers a non-destructive import when only a legacy project rules file exists', async () => {
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/AGENTS.md')) return { file: '', error: '', found: false };
      if (path.endsWith('/.codebuddyhints')) {
        return { file: 'legacy instructions', error: '', found: true };
      }
      return { file: '', error: '', found: false };
    });

    render(<GoosehintsModal directory="D:/workspace" setIsGoosehintsModalOpen={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Import into AGENTS.md' }));
    expect(screen.getByPlaceholderText('Enter project instructions here...')).toHaveValue(
      'legacy instructions'
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('edits an existing AGENTS.override.md because it has higher precedence', async () => {
    readFile.mockImplementation(async (path: string) =>
      path.endsWith('/AGENTS.override.md')
        ? { file: 'override instructions', error: '', found: true }
        : { file: '', error: '', found: false }
    );
    writeFile.mockResolvedValue(true);

    render(<GoosehintsModal directory="D:/workspace" setIsGoosehintsModalOpen={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    const editor = await screen.findByPlaceholderText('Enter project instructions here...');
    expect(editor).toHaveValue('override instructions');
    fireEvent.change(editor, { target: { value: 'updated override' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith('D:/workspace/AGENTS.override.md', 'updated override')
    );
  });
});
