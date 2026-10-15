import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalModelManager } from './LocalModelManager';

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  getDictationConfig: vi.fn(),
  listLocalDictationModels: vi.fn(),
  selectLocalDictationModel: vi.fn(),
  downloadLocalDictationModel: vi.fn(),
  getLocalDictationModelDownloadProgress: vi.fn(),
  cancelLocalDictationModelDownload: vi.fn(),
  deleteLocalDictationModel: vi.fn(),
}));

vi.mock('../../ConfigContext', () => ({
  useConfig: mocks.useConfig,
}));

vi.mock('../../../acp/dictation', () => ({
  getDictationConfig: mocks.getDictationConfig,
  listLocalDictationModels: mocks.listLocalDictationModels,
  selectLocalDictationModel: mocks.selectLocalDictationModel,
  downloadLocalDictationModel: mocks.downloadLocalDictationModel,
  getLocalDictationModelDownloadProgress: mocks.getLocalDictationModelDownloadProgress,
  cancelLocalDictationModelDownload: mocks.cancelLocalDictationModelDownload,
  deleteLocalDictationModel: mocks.deleteLocalDictationModel,
}));

vi.mock('../../../i18n', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }, values?: Record<string, unknown>) =>
      message.defaultMessage.replace('{count}', String(values?.count ?? '')),
  }),
}));

vi.mock('../../ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

const models = [
  {
    id: 'tiny',
    label: 'Tiny',
    description: 'Tiny model',
    sizeMb: 75,
    downloaded: true,
    downloadInProgress: false,
    recommended: true,
  },
  {
    id: 'base',
    label: 'Base',
    description: 'Base model',
    sizeMb: 142,
    downloaded: true,
    downloadInProgress: false,
    recommended: false,
  },
];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe('LocalModelManager typed lifecycle', () => {
  const genericRead = vi.fn();
  const genericUpsert = vi.fn();
  const genericRemove = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useConfig.mockReturnValue({
      read: genericRead,
      upsert: genericUpsert,
      remove: genericRemove,
      config: {},
    });
    mocks.getDictationConfig.mockResolvedValue({
      local: { selectedModel: 'tiny' },
    });
    mocks.listLocalDictationModels.mockResolvedValue(models);
    mocks.selectLocalDictationModel.mockResolvedValue(undefined);
    mocks.deleteLocalDictationModel.mockResolvedValue(undefined);
    mocks.downloadLocalDictationModel.mockResolvedValue(undefined);
    mocks.getLocalDictationModelDownloadProgress.mockResolvedValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('reads and selects the active local model only through typed ACP methods', async () => {
    mocks.getDictationConfig
      .mockResolvedValueOnce({ local: { selectedModel: 'tiny' } })
      .mockResolvedValueOnce({ local: { selectedModel: 'base' } });
    render(<LocalModelManager />);

    const radios = await screen.findAllByRole('radio');
    expect(radios[0]).toBeChecked();
    fireEvent.click(radios[1]);

    await waitFor(() => expect(mocks.selectLocalDictationModel).toHaveBeenCalledWith('base'));
    await waitFor(() => expect(radios[1]).toBeChecked());
    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2);
    expect(mocks.useConfig).not.toHaveBeenCalled();
    expect(genericRead).not.toHaveBeenCalled();
    expect(genericUpsert).not.toHaveBeenCalled();
    expect(genericRemove).not.toHaveBeenCalled();
  });

  it('refreshes authoritative state after a typed selection fails', async () => {
    mocks.selectLocalDictationModel.mockRejectedValue(new Error('select unavailable'));
    render(<LocalModelManager />);
    const radios = await screen.findAllByRole('radio');

    fireEvent.click(radios[1]);

    await waitFor(() => expect(mocks.selectLocalDictationModel).toHaveBeenCalledWith('base'));
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
    expect(mocks.useConfig).not.toHaveBeenCalled();
  });

  it('uses typed delete without compensating generic writes and refreshes cleared authority', async () => {
    mocks.listLocalDictationModels
      .mockResolvedValueOnce(models)
      .mockResolvedValueOnce([{ ...models[0], downloaded: false }, models[1]]);
    mocks.getDictationConfig
      .mockResolvedValueOnce({ local: { selectedModel: 'tiny' } })
      .mockResolvedValueOnce({ local: { selectedModel: null } });
    render(<LocalModelManager />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'tiny' })).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Delete tiny' }));

    await waitFor(() => expect(mocks.deleteLocalDictationModel).toHaveBeenCalledWith('tiny'));
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    expect(genericUpsert).not.toHaveBeenCalled();
    expect(mocks.useConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('radio', { name: 'tiny' })).not.toBeInTheDocument();
  });

  it('refreshes cleared authority after typed delete rejects while the model file remains', async () => {
    mocks.deleteLocalDictationModel.mockRejectedValue(new Error('delete unavailable'));
    mocks.getDictationConfig
      .mockResolvedValueOnce({ local: { selectedModel: 'tiny' } })
      .mockResolvedValueOnce({ local: { selectedModel: null } });
    render(<LocalModelManager />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'tiny' })).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Delete tiny' }));

    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('radio', { name: 'tiny' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'base' })).not.toBeChecked();
    expect(genericUpsert).not.toHaveBeenCalled();
  });

  it('refreshes authority when a typed download start rejects', async () => {
    mocks.listLocalDictationModels.mockResolvedValue([
      {
        ...models[0],
        id: 'small',
        downloaded: false,
      },
    ]);
    mocks.getDictationConfig.mockResolvedValue({ local: { selectedModel: null } });
    mocks.downloadLocalDictationModel.mockRejectedValue(new Error('download unavailable'));
    render(<LocalModelManager />);
    const download = await screen.findByRole('button', { name: 'Download' });

    fireEvent.click(download);

    await waitFor(() => expect(mocks.downloadLocalDictationModel).toHaveBeenCalledWith('small'));
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    expect(mocks.listLocalDictationModels).toHaveBeenCalledTimes(2);
  });

  it('resumes polling an authoritative in-progress download without starting it again', async () => {
    mocks.listLocalDictationModels.mockResolvedValue([
      {
        ...models[0],
        id: 'small',
        downloaded: false,
        downloadInProgress: true,
      },
    ]);
    mocks.getDictationConfig.mockResolvedValue({ local: { selectedModel: null } });
    mocks.getLocalDictationModelDownloadProgress.mockResolvedValue({
      bytesDownloaded: 40,
      totalBytes: 100,
      progressPercent: 40,
      status: 'downloading',
    });
    render(<LocalModelManager />);

    await screen.findByText('Small');
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(mocks.downloadLocalDictationModel).not.toHaveBeenCalled();

    await screen.findByText('40%');

    expect(mocks.downloadLocalDictationModel).not.toHaveBeenCalled();
    expect(mocks.getLocalDictationModelDownloadProgress).toHaveBeenCalledWith('small');
  });

  it('does not refresh authority when a pending selection resolves after unmount', async () => {
    const pending = deferred<void>();
    mocks.selectLocalDictationModel.mockReturnValue(pending.promise);
    const { unmount } = render(<LocalModelManager />);
    const radios = await screen.findAllByRole('radio');

    fireEvent.click(radios[1]);
    await waitFor(() => expect(mocks.selectLocalDictationModel).toHaveBeenCalledWith('base'));
    unmount();
    pending.resolve(undefined);
    await delay(50);

    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1);
    expect(mocks.listLocalDictationModels).toHaveBeenCalledTimes(1);
  });

  it('does not refresh authority when a pending deletion resolves after unmount', async () => {
    const pending = deferred<void>();
    mocks.deleteLocalDictationModel.mockReturnValue(pending.promise);
    const { unmount } = render(<LocalModelManager />);
    await screen.findByRole('button', { name: 'Delete tiny' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete tiny' }));
    await waitFor(() => expect(mocks.deleteLocalDictationModel).toHaveBeenCalledWith('tiny'));
    unmount();
    pending.resolve(undefined);
    await delay(50);

    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1);
    expect(mocks.listLocalDictationModels).toHaveBeenCalledTimes(1);
  });

  it('serializes progress reads for the same model while a prior read is pending', async () => {
    const pending = deferred<null>();
    mocks.listLocalDictationModels.mockResolvedValue([
      { ...models[0], id: 'small', downloaded: false },
    ]);
    mocks.getDictationConfig.mockResolvedValue({ local: { selectedModel: null } });
    mocks.getLocalDictationModelDownloadProgress.mockReturnValue(pending.promise);
    render(<LocalModelManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mocks.downloadLocalDictationModel).toHaveBeenCalledWith('small'));
    await delay(1_100);

    expect(mocks.getLocalDictationModelDownloadProgress).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
  });

  it('ignores a progress read that resolves after cancellation', async () => {
    const late = deferred<{
      bytesDownloaded: number;
      totalBytes: number;
      progressPercent: number;
      status: string;
    }>();
    mocks.listLocalDictationModels.mockResolvedValue([
      { ...models[0], id: 'small', downloaded: false },
    ]);
    mocks.getDictationConfig.mockResolvedValue({ local: { selectedModel: null } });
    mocks.getLocalDictationModelDownloadProgress
      .mockResolvedValueOnce({
        bytesDownloaded: 25,
        totalBytes: 100,
        progressPercent: 25,
        status: 'downloading',
      })
      .mockReturnValueOnce(late.promise);
    render(<LocalModelManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('25%');
    await waitFor(() =>
      expect(mocks.getLocalDictationModelDownloadProgress).toHaveBeenCalledTimes(2)
    );
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mocks.cancelLocalDictationModelDownload).toHaveBeenCalledWith('small')
    );
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));

    late.resolve({
      bytesDownloaded: 77,
      totalBytes: 100,
      progressPercent: 77,
      status: 'downloading',
    });
    await delay(50);

    expect(screen.queryByText('77%')).not.toBeInTheDocument();
    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2);
  });

  it('allows only one terminal poll generation to refresh authority', async () => {
    const older = deferred<{
      bytesDownloaded: number;
      totalBytes: number;
      progressPercent: number;
      status: string;
    }>();
    mocks.listLocalDictationModels.mockResolvedValue([
      { ...models[0], id: 'small', downloaded: false },
    ]);
    mocks.getDictationConfig.mockResolvedValue({ local: { selectedModel: null } });
    mocks.getLocalDictationModelDownloadProgress
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({
        bytesDownloaded: 100,
        totalBytes: 100,
        progressPercent: 100,
        status: 'completed',
      });
    render(<LocalModelManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await delay(1_100);
    older.resolve({
      bytesDownloaded: 100,
      totalBytes: 100,
      progressPercent: 100,
      status: 'completed',
    });
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    await delay(100);

    expect(mocks.getLocalDictationModelDownloadProgress).toHaveBeenCalledTimes(1);
    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2);
    expect(mocks.listLocalDictationModels).toHaveBeenCalledTimes(2);
  });

  it('does not refresh authority when a pending poll resolves after unmount', async () => {
    const pending = deferred<null>();
    mocks.listLocalDictationModels.mockResolvedValue([
      { ...models[0], id: 'small', downloaded: false },
    ]);
    mocks.getDictationConfig.mockResolvedValue({ local: { selectedModel: null } });
    mocks.getLocalDictationModelDownloadProgress.mockReturnValue(pending.promise);
    const { unmount } = render(<LocalModelManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(mocks.getLocalDictationModelDownloadProgress).toHaveBeenCalledTimes(1)
    );
    unmount();
    pending.resolve(null);
    await delay(50);

    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1);
    expect(mocks.listLocalDictationModels).toHaveBeenCalledTimes(1);
  });
});
