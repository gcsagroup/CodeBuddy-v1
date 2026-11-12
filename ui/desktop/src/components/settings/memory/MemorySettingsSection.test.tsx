import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCodeProMemory,
  listCodeProMemory,
} from '../../../acp/memory';
import { getConfiguredExtensions, setConfigExtensionEnabled } from '../../../acp/extensions';
import { readPreferences, savePreferences } from '../../../acp/preferences';
import MemorySettingsSection from './MemorySettingsSection';

vi.mock('../../../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (
      message: { defaultMessage: string },
      values?: Record<string, string | number>
    ) =>
      Object.entries(values ?? {}).reduce(
        (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
        message.defaultMessage
      ),
  }),
}));

vi.mock('../../../acp/memory', () => ({
  listCodeProMemory: vi.fn(),
  deleteCodeProMemory: vi.fn(),
}));

vi.mock('../../../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn(),
  setConfigExtensionEnabled: vi.fn(),
}));

vi.mock('../../../acp/preferences', () => ({
  readPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

describe('MemorySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron.listRecentDirs = vi.fn().mockResolvedValue(['D:\\project-a']);
    vi.mocked(getConfiguredExtensions).mockResolvedValue({
      extensions: [
        {
          type: 'platform',
          name: 'projectmemory',
          description: 'Project memory',
          enabled: true,
          configKey: 'projectmemory',
        },
      ],
      warnings: [],
    });
    vi.mocked(setConfigExtensionEnabled).mockResolvedValue();
    vi.mocked(readPreferences).mockResolvedValue({
      revision: 0,
      values: [
        {
          key: 'personalizedMemoryEnabled',
          value: null,
          isMutable: true,
        },
      ],
    });
    vi.mocked(savePreferences).mockResolvedValue({
      revision: 1,
      values: [
        {
          key: 'personalizedMemoryEnabled',
          value: true,
          isMutable: true,
        },
      ],
    });
  });

  it('lets the user opt in to automatic low-risk preference memory', async () => {
    render(<MemorySettingsSection />);

    const toggle = await screen.findByRole('switch', {
      name: 'Automatically remember my working habits',
    });
    expect(toggle).not.toBeChecked();
    expect(readPreferences).toHaveBeenCalledWith(['personalizedMemoryEnabled']);

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(savePreferences).toHaveBeenCalledWith([
        {
          key: 'personalizedMemoryEnabled',
          value: true,
          isMutable: true,
        },
      ])
    );
    expect(toggle).toBeChecked();
    expect(deleteCodeProMemory).not.toHaveBeenCalled();
  });

  it('turns project memory off without deleting stored records', async () => {
    render(<MemorySettingsSection />);

    const toggle = await screen.findByRole('switch', { name: 'Enable project memory' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setConfigExtensionEnabled).toHaveBeenCalledWith('projectmemory', false)
    );
    expect(toggle).not.toBeChecked();
    expect(deleteCodeProMemory).not.toHaveBeenCalled();
    expect(listCodeProMemory).not.toHaveBeenCalled();
  });

  it('shows controls without listing or deleting saved records', async () => {
    render(<MemorySettingsSection />);
    await waitFor(() => expect(readPreferences).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Manage project memory' })).not.toBeInTheDocument();
    expect(screen.queryByText('Saved project memory')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(listCodeProMemory).not.toHaveBeenCalled();
    expect(deleteCodeProMemory).not.toHaveBeenCalled();
    expect(window.electron.listRecentDirs).not.toHaveBeenCalled();
  });
  it('reports persistence errors and keeps the previous switch value', async () => {
    vi.mocked(setConfigExtensionEnabled).mockRejectedValueOnce(new Error('Save failed'));
    render(<MemorySettingsSection />);
    await waitFor(() => expect(readPreferences).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch', { name: 'Enable project memory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByRole('switch', { name: 'Enable project memory' })).toBeChecked();
  });
});
