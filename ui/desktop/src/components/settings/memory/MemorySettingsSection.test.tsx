import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCodeProMemory,
  exportCodeProMemory,
  listCodeProMemory,
  setCodeProMemoryStatus,
  updateCodeProMemory,
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
  updateCodeProMemory: vi.fn(),
  deleteCodeProMemory: vi.fn(),
  exportCodeProMemory: vi.fn(),
  setCodeProMemoryStatus: vi.fn(),
}));

vi.mock('../../../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn(),
  setConfigExtensionEnabled: vi.fn(),
}));

vi.mock('../../../acp/preferences', () => ({
  readPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

const record = {
  id: 'memory-1',
  kind: 'verified_fact',
  subject: 'rust_toolchain',
  content: 'Rust is pinned to 1.96.1',
  scope: 'project',
  source: 'project_evidence',
  status: 'active' as const,
  reason: 'Verified from the checked-in toolchain file',
  sourceRef: 'rust-toolchain.toml',
  confidence: 'high',
  createdAt: '2026-08-21T00:00:00Z',
  updatedAt: '2026-08-21T00:00:00Z',
  expiresAt: undefined,
  expired: false,
  recallable: true,
};

describe('MemorySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron.listRecentDirs = vi.fn().mockResolvedValue(['D:\\project-a']);
    window.electron.showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    window.electron.showSaveDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePath: 'D:\\memory.json' });
    window.electron.writeFile = vi.fn().mockResolvedValue(true);
    vi.mocked(listCodeProMemory).mockResolvedValue({
      schemaVersion: 1,
      projectIdentity: 'project-a',
      records: [record],
      totalRecords: 1,
      usageBytes: 1024,
      softLimitBytes: 1024 * 1024,
      hardLimitBytes: 2 * 1024 * 1024,
    });
    vi.mocked(updateCodeProMemory).mockImplementation(async (input) => ({
      ...record,
      content: input.content,
      reason: input.reason,
    }));
    vi.mocked(deleteCodeProMemory).mockResolvedValue(true);
    vi.mocked(exportCodeProMemory).mockResolvedValue({
      fileName: 'codepro-memory-project-a.json',
      json: '{"records":[]}',
    });
    vi.mocked(setCodeProMemoryStatus).mockImplementation(async ({ record, targetStatus }) => ({
      outcome: 'committed',
      changed: true,
      record: {
        ...record,
        status: targetStatus,
        recallable: targetStatus === 'active',
        updatedAt: '2026-09-12T00:00:02.000000000Z',
      },
    }));
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
    expect(screen.queryByText('Saved memory')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(listCodeProMemory).not.toHaveBeenCalled();
    expect(deleteCodeProMemory).not.toHaveBeenCalled();
    expect(window.electron.listRecentDirs).not.toHaveBeenCalled();
  });
  it('opens project records explicitly and approves the reviewed snapshot without changing scope', async () => {
    const candidate = {
      ...record,
      status: 'candidate' as const,
      recallable: false,
      reviewFingerprint: 'f'.repeat(64),
    };
    vi.mocked(listCodeProMemory).mockResolvedValue({
      schemaVersion: 1,
      projectIdentity: 'project-a',
      records: [candidate],
      totalRecords: 1,
      usageBytes: 1024,
      softLimitBytes: 2048,
      hardLimitBytes: 4096,
    });
    render(<MemorySettingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage project memory' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project directory' }), {
      target: { value: 'D:\\project-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load records' }));
    expect(await screen.findByText(candidate.content)).toBeInTheDocument();
    expect(setCodeProMemoryStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve for recall' }));
    await waitFor(() =>
      expect(setCodeProMemoryStatus).toHaveBeenCalledWith({
        workingDir: 'D:\\project-a',
        record: candidate,
        targetStatus: 'active',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Project directory' })).not.toBeDisabled()
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Project directory' }), {
      target: { value: 'D:\\project-b' },
    });
    expect(screen.queryByText(candidate.content)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve for recall' })).not.toBeInTheDocument();
  });

  it('refreshes changed review content without retrying approval automatically', async () => {
    const candidate = {
      ...record,
      status: 'candidate' as const,
      reviewFingerprint: 'f'.repeat(64),
    };
    vi.mocked(listCodeProMemory).mockResolvedValueOnce({
      schemaVersion: 1,
      projectIdentity: 'project-a',
      records: [candidate],
      totalRecords: 1,
      usageBytes: 1024,
      softLimitBytes: 2048,
      hardLimitBytes: 4096,
    });
    vi.mocked(setCodeProMemoryStatus).mockResolvedValue({
      outcome: 'needs_review',
      record: null,
      changed: null,
    });
    render(<MemorySettingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage project memory' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project directory' }), {
      target: { value: 'D:\\project-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load records' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve for recall' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The record changed');
    expect(setCodeProMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('edits through the memory API and requires explicit confirmation before deletion', async () => {
    render(<MemorySettingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage project memory' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project directory' }), {
      target: { value: 'D:\\project-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load records' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory content' }), {
      target: { value: 'Corrected project fact' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateCodeProMemory).toHaveBeenCalledWith({
        workingDir: 'D:\\project-a',
        id: record.id,
        content: 'Corrected project fact',
        reason: record.reason,
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete record' })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete record' }));
    expect(deleteCodeProMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }));
    await waitFor(() =>
      expect(deleteCodeProMemory).toHaveBeenCalledWith('D:\\project-a', record.id)
    );
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
