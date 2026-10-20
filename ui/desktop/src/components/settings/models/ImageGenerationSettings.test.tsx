import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ImageGenerationSettings from './ImageGenerationSettings';
import { readPreferences, savePreferences } from '../../../acp/preferences';
vi.mock('../../../i18n', () => ({ currentLocale: 'en' }));
vi.mock('../../../acp/preferences', () => ({ readPreferences: vi.fn(), savePreferences: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('loads saved service, persists an edit, and never reports failed saves as saved', async () => {
  vi.mocked(readPreferences).mockResolvedValue({
    revision: 1,
    values: [{ key: 'comfyuiBaseUrl', value: 'http://old:8188', isMutable: true }],
  });
  vi.mocked(savePreferences).mockRejectedValueOnce(new Error('Offline'));
  render(<ImageGenerationSettings />);
  await waitFor(() => expect(screen.getByLabelText('ComfyUI URL')).toHaveValue('http://old:8188'));
  fireEvent.change(screen.getByLabelText('ComfyUI URL'), { target: { value: 'http://new:8188/' } });
  fireEvent.click(screen.getByText('Save media service'));
  await screen.findByText('Error: Offline');
  expect(savePreferences).toHaveBeenCalledWith([
    { key: 'comfyuiBaseUrl', value: 'http://new:8188', isMutable: true },
  ]);
  expect(screen.queryByText(/Saved\./)).not.toBeInTheDocument();
});
it('rejects credential-bearing URLs before saving', async () => {
  vi.mocked(readPreferences).mockResolvedValue({ revision: 1, values: [] });
  render(<ImageGenerationSettings />);
  await waitFor(() => expect(screen.getByText('Save media service')).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText('ComfyUI URL'), {
    target: { value: 'http://name:secret@host' },
  });
  fireEvent.click(screen.getByText('Save media service'));
  expect(savePreferences).not.toHaveBeenCalled();
  expect(await screen.findByRole('status')).toHaveTextContent('without credentials');
});
