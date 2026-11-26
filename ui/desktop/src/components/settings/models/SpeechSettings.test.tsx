import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { checkDictationService } from '../../../acp/dictation';
import { SpeechSettings } from './SpeechSettings';
vi.mock('../../../acp/config', () => ({ acpReadConfig: vi.fn(), acpUpsertConfig: vi.fn() }));
vi.mock('../../../acp/dictation', () => ({ checkDictationService: vi.fn() }));
const existing = { REMOTE_ASR_URL: 'http://localhost:8000/v1/audio/transcriptions', REMOTE_ASR_MODEL: 'recognizer', REMOTE_TTS_URL: 'http://localhost:8001', extra: 'preserved' };
const setup = () => render(<SpeechSettings />, { wrapper: IntlTestWrapper });
describe('SpeechSettings', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(acpReadConfig).mockResolvedValue(existing); vi.mocked(acpUpsertConfig).mockResolvedValue(undefined); vi.mocked(checkDictationService).mockResolvedValue(undefined); });
  it('saves before checking, preserves hidden settings, and clears the draft', async () => {
    setup();
    const model = await screen.findByDisplayValue('recognizer');
    fireEvent.change(model, { target: { value: 'updated' } });
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByText('Saved. Speech service is reachable.')).toBeVisible();
    expect(acpUpsertConfig).toHaveBeenCalledWith('SPEECH_SERVICES', { ...existing, REMOTE_ASR_MODEL: 'updated' });
    expect(vi.mocked(acpUpsertConfig).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(checkDictationService).mock.invocationCallOrder[0]);
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });
  it('distinguishes a saved configuration from a failed connection check', async () => {
    vi.mocked(checkDictationService).mockRejectedValue(new Error('Service unavailable'));
    setup(); await screen.findByDisplayValue('recognizer');
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved, but the connection check failed: Service unavailable');
  });
  it('rejects invalid drafts without saving and allows discarding them', async () => {
    setup(); const input = await screen.findByDisplayValue(existing.REMOTE_ASR_URL);
    fireEvent.change(input, { target: { value: 'bad-url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid HTTP(S) endpoint.');
    expect(acpUpsertConfig).not.toHaveBeenCalled(); expect(checkDictationService).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input).toHaveValue(existing.REMOTE_ASR_URL);
  });
  it('retries reading without overwriting an unread configuration', async () => {
    vi.mocked(acpReadConfig).mockRejectedValueOnce(new Error('offline'));
    setup(); fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByDisplayValue('recognizer')).toBeEnabled());
    expect(acpUpsertConfig).not.toHaveBeenCalled();
  });
});
