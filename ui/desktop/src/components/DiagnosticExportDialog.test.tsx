import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { acpExportSessionLog } from '../acp/sessions';
import { DiagnosticExportDialog } from './DiagnosticExportDialog';
import { toast } from 'react-toastify';
vi.mock('../acp/sessions', () => ({ acpExportSessionLog: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const standard = '{"type":"log-export","detail":"standard"}\n';
const detailed =
  '{"type":"log-export","detail":"detailed","error":"<script>window.EXECUTED=true</script>"}\n';
const destination = { canceled: false, filePath: '/chosen/diagnostic.jsonl' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acpExportSessionLog).mockResolvedValue(standard);
  Object.assign(window.electron, {
    showSaveDialog: vi.fn().mockResolvedValue(destination),
    writeFile: vi.fn().mockResolvedValue(true),
  });
});
function show() {
  const close = vi.fn();
  const view = render(<DiagnosticExportDialog sessionId="first" open onOpenChange={close} />, {
    wrapper: IntlTestWrapper,
  });
  return { close, ...view };
}
it('previews without saving and writes exactly that snapshot after an explicit action', async () => {
  show();
  expect(await screen.findByRole('textbox', { name: 'File preview' })).toHaveValue(standard);
  expect(window.electron.showSaveDialog).not.toHaveBeenCalled();
  vi.mocked(acpExportSessionLog).mockResolvedValue(
    'A later history snapshot must not replace the preview'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save this preview' }));
  await waitFor(() =>
    expect(window.electron.writeFile).toHaveBeenCalledWith(destination.filePath, standard)
  );
  expect(acpExportSessionLog).toHaveBeenCalledExactlyOnceWith('first', 'standard');
});
it('previews detailed logs as inert plain text without an extra confirmation checkbox', async () => {
  show();
  await screen.findByRole('textbox');
  vi.mocked(acpExportSessionLog).mockResolvedValue(detailed);
  fireEvent.click(screen.getByRole('radio', { name: /Detailed logs/ }));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(detailed));
  expect(screen.getByRole('button', { name: 'Save this preview' })).toBeEnabled();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save this preview' }));
  await waitFor(() =>
    expect(window.electron.writeFile).toHaveBeenCalledWith(destination.filePath, detailed)
  );
});

it('does not close a new preview when an older file write completes', async () => {
  let finish!: (result: boolean) => void;
  vi.mocked(window.electron.writeFile).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const view = show();
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'Save this preview' }));
  await waitFor(() => expect(window.electron.writeFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  view.rerender(<DiagnosticExportDialog sessionId="second" open onOpenChange={view.close} />);
  await screen.findByRole('textbox');
  await act(async () => finish(true));
  expect(view.close).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog')).toBeVisible();
});
it('ignores a late detailed read when another mode was selected', async () => {
  show();
  await screen.findByRole('textbox');
  let finish!: (text: string) => void;
  vi.mocked(acpExportSessionLog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  fireEvent.click(screen.getByRole('radio', { name: /Detailed logs/ }));
  fireEvent.click(screen.getByRole('radio', { name: /Standard logs/ }));
  await screen.findByRole('textbox');
  await act(async () => finish(detailed));
  expect(screen.getByRole('textbox')).toHaveValue(standard);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
it('drops the old preview when switching sessions while the new read is pending', async () => {
  const view = show();
  await screen.findByRole('textbox');
  let finish!: (text: string) => void;
  vi.mocked(acpExportSessionLog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  view.rerender(<DiagnosticExportDialog sessionId="second" open onOpenChange={view.close} />);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save this preview' })).toBeDisabled();
  await act(async () => finish('second snapshot'));
  expect(screen.getByRole('textbox')).toHaveValue('second snapshot');
});
it('does not write when the save dialog is cancelled', async () => {
  vi.mocked(window.electron.showSaveDialog).mockResolvedValue({ canceled: true });
  show();
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'Save this preview' }));
  await waitFor(() => expect(window.electron.showSaveDialog).toHaveBeenCalledOnce());
  expect(window.electron.writeFile).not.toHaveBeenCalled();
});
it('ignores a save destination returned after the preview was closed', async () => {
  let finish!: (result: typeof destination) => void;
  vi.mocked(window.electron.showSaveDialog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  show();
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'Save this preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => finish(destination));
  expect(window.electron.writeFile).not.toHaveBeenCalled();
});
it('does not expose exceptions from reads or writes and can retry a failed read', async () => {
  vi.mocked(acpExportSessionLog).mockRejectedValueOnce(Error('PRIVATE_PATH_AND_KEY'));
  show();
  expect(await screen.findByRole('alert')).not.toHaveTextContent('PRIVATE_PATH_AND_KEY');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('textbox');
  vi.mocked(window.electron.writeFile).mockRejectedValueOnce(Error('PRIVATE_PATH_AND_KEY'));
  fireEvent.click(screen.getByRole('button', { name: 'Save this preview' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('PRIVATE_PATH_AND_KEY');
});
