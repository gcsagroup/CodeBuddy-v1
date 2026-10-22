import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import ExternalBackendSection from './ExternalBackendSection';

const originalElectron = window.electron;
afterEach(() => {
  window.electron = originalElectron;
});

function setup(enabled = true) {
  const config = { enabled, url: 'https://backend.example', secret: '', certFingerprint: '' };
  const setSetting = vi.fn().mockResolvedValue(undefined);
  window.electron = {
    ...originalElectron,
    getSetting: vi.fn().mockResolvedValue(config),
    setSetting,
  };
  render(<ExternalBackendSection />, { wrapper: IntlTestWrapper });
  return { config, setSetting };
}

describe('external backend settings save boundaries', () => {
  it('does not persist an invalid URL through another field blur', async () => {
    const { setSetting } = setup();
    const url = await screen.findByLabelText('Backend Base URL');
    fireEvent.change(url, { target: { value: 'ftp://invalid.example' } });
    fireEvent.blur(url);
    fireEvent.change(screen.getByLabelText('Secret Key'), { target: { value: 'fixture-only' } });
    fireEvent.blur(screen.getByLabelText('Secret Key'));
    await waitFor(() =>
      expect(screen.getByText('URL must use http or https protocol')).toBeVisible()
    );
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('keeps a failed toggle unchanged and shows a retryable error', async () => {
    const { setSetting } = setup(false);
    await waitFor(() => expect(window.electron.getSetting).toHaveBeenCalled());
    setSetting.mockRejectedValueOnce(new Error('fixture save failure'));
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByRole('alert');
    expect(screen.getByRole('switch')).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('can disable the connection without persisting an invalid draft', async () => {
    const { config, setSetting } = setup();
    const url = await screen.findByLabelText('Backend Base URL');
    fireEvent.change(url, { target: { value: 'ftp://invalid.example' } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked());
    expect(setSetting).toHaveBeenCalledExactlyOnceWith('externalGoosed', {
      ...config,
      enabled: false,
    });
  });
});
