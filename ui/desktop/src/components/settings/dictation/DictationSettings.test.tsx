import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DictationSettings } from './DictationSettings';

const mocks = vi.hoisted(() => ({
  getDictationConfig: vi.fn(),
  saveDictationSecret: vi.fn(),
  deleteDictationSecret: vi.fn(),
  readDictationSettings: vi.fn(),
  setDictationProvider: vi.fn(),
  setDictationPreferredMic: vi.fn(),
  legacyReadPreference: vi.fn(),
  legacyWritePreference: vi.fn(),
  useConfig: vi.fn(),
  useFeatures: vi.fn(),
  trackSettingToggled: vi.fn(),
}));

vi.mock('../../../acp/dictation', () => ({
  getDictationConfig: mocks.getDictationConfig,
  saveDictationSecret: mocks.saveDictationSecret,
  deleteDictationSecret: mocks.deleteDictationSecret,
}));

vi.mock('./dictationPreferences', () => ({
  readDictationSettings: mocks.readDictationSettings,
  setDictationProvider: mocks.setDictationProvider,
  setDictationPreferredMic: mocks.setDictationPreferredMic,
  DICTATION_PROVIDER_KEY: { canonical: 'legacy-provider', legacy: 'legacy-provider' },
  DICTATION_PREFERRED_MIC_KEY: { canonical: 'legacy-mic', legacy: 'legacy-mic' },
  readDictationPreference: mocks.legacyReadPreference,
  writeDictationPreference: mocks.legacyWritePreference,
}));

vi.mock('../../ConfigContext', () => ({
  useConfig: mocks.useConfig,
}));

vi.mock('../../../contexts/FeaturesContext', () => ({
  useFeatures: mocks.useFeatures,
}));

vi.mock('../../../utils/analytics', () => ({
  trackSettingToggled: mocks.trackSettingToggled,
}));

vi.mock('../../../updates', () => ({
  DICTATION_ALLOWED_PROVIDERS: undefined,
}));

vi.mock('../../../i18n', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

vi.mock('../../ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('../../ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../../ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      {children}
      <button onClick={() => onOpenChange?.(true)}>refresh-statuses</button>
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="provider-label">{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ onValueChange }: { onValueChange: (value: string) => void }) => (
    <div>
      <button onClick={() => onValueChange('disabled')}>select-disabled</button>
      <button onClick={() => onValueChange('openai')}>select-openai</button>
      <button onClick={() => onValueChange('groq')}>select-groq</button>
      <button onClick={() => onValueChange('local')}>select-local</button>
    </div>
  ),
  DropdownMenuRadioItem: () => null,
}));

vi.mock('./LocalModelManager', () => ({
  LocalModelManager: () => <div>local-model-manager</div>,
}));

vi.mock('./MicrophoneSelector', () => ({
  MicrophoneSelector: ({
    selectedDeviceId,
    onDeviceChange,
  }: {
    selectedDeviceId: string | null;
    onDeviceChange: (deviceId: string | null) => void;
  }) => (
    <div>
      <span data-testid="selected-mic">{selectedDeviceId ?? 'no-mic'}</span>
      <button onClick={() => onDeviceChange(null)}>clear-mic</button>
      <button onClick={() => onDeviceChange('mic-2')}>select-mic-2</button>
      <button onClick={() => onDeviceChange('mic-3')}>select-mic-3</button>
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const providerStatuses = {
  openai: {
    configured: false,
    description: 'OpenAI',
    usesProviderConfig: false,
    configKey: 'OPENAI_API_KEY',
  },
  groq: {
    configured: false,
    description: 'Groq',
    usesProviderConfig: false,
    configKey: 'GROQ_API_KEY',
  },
  local: {
    configured: true,
    description: 'Local',
    usesProviderConfig: false,
  },
};

describe('DictationSettings typed state and lifecycle', () => {
  const genericRead = vi.fn();
  const genericUpsert = vi.fn();
  const genericRemove = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useFeatures.mockReturnValue({ localInference: true, isLoading: false });
    mocks.useConfig.mockReturnValue({
      read: genericRead,
      upsert: genericUpsert,
      remove: genericRemove,
      config: {},
    });
    mocks.readDictationSettings.mockResolvedValue({
      revision: 1,
      provider: 'openai',
      preferredMic: 'mic-1',
    });
    mocks.legacyReadPreference.mockImplementation(async (_read, _upsert, _remove, key) =>
      key.canonical === 'legacy-provider' ? 'openai' : 'mic-1'
    );
    mocks.getDictationConfig.mockResolvedValue(providerStatuses);
    mocks.setDictationProvider.mockResolvedValue(undefined);
    mocks.setDictationPreferredMic.mockResolvedValue(undefined);
    mocks.legacyWritePreference.mockResolvedValue(undefined);
    mocks.saveDictationSecret.mockResolvedValue(undefined);
    mocks.deleteDictationSecret.mockResolvedValue(undefined);
  });

  it('loads and mutates only through typed preferences, including null disable and mic clear', async () => {
    render(<DictationSettings />);

    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));
    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-1');
    fireEvent.click(screen.getByRole('button', { name: 'clear-mic' }));
    await waitFor(() => expect(mocks.setDictationPreferredMic).toHaveBeenCalledWith(null));
    fireEvent.click(screen.getByRole('button', { name: 'select-disabled' }));
    await waitFor(() => expect(mocks.setDictationProvider).toHaveBeenCalledWith(null));

    expect(mocks.readDictationSettings).toHaveBeenCalledTimes(1);
    expect(mocks.useConfig).not.toHaveBeenCalled();
    expect(mocks.legacyReadPreference).not.toHaveBeenCalled();
    expect(mocks.legacyWritePreference).not.toHaveBeenCalled();
    expect(genericRead).not.toHaveBeenCalled();
    expect(genericUpsert).not.toHaveBeenCalled();
    expect(genericRemove).not.toHaveBeenCalled();
  });

  it('rolls back the latest provider intent when its typed mutation fails', async () => {
    mocks.setDictationProvider.mockRejectedValue(new Error('save unavailable'));
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));

    await waitFor(() => expect(mocks.setDictationProvider).toHaveBeenCalledWith('groq'));
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));
  });

  it('rolls back the latest microphone intent when its typed mutation fails', async () => {
    mocks.setDictationPreferredMic.mockRejectedValue(new Error('save unavailable'));
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-1'));

    fireEvent.click(screen.getByRole('button', { name: 'select-mic-2' }));

    await waitFor(() => expect(mocks.setDictationPreferredMic).toHaveBeenCalledWith('mic-2'));
    await waitFor(() => expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-1'));
  });

  it('does not let an older provider failure roll back a newer successful intent', async () => {
    const older = deferred<void>();
    mocks.setDictationProvider.mockReturnValueOnce(older.promise).mockResolvedValueOnce(undefined);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-local' }));
    await waitFor(() => expect(mocks.setDictationProvider).toHaveBeenCalledTimes(2));
    await act(async () => older.reject(new Error('older save failed')));

    expect(screen.getByTestId('provider-label')).toHaveTextContent('Local');
  });

  it('still rolls back a failed provider intent after an intervening status refresh', async () => {
    const providerWrite = deferred<void>();
    mocks.setDictationProvider.mockReturnValue(providerWrite.promise);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    fireEvent.click(screen.getByRole('button', { name: 'refresh-statuses' }));
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    await act(async () => providerWrite.reject(new Error('provider save failed')));

    expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai');
  });

  it('still rolls back a failed provider intent after a newer microphone intent', async () => {
    const providerWrite = deferred<void>();
    mocks.setDictationProvider.mockReturnValue(providerWrite.promise);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-mic-2' }));
    await waitFor(() => expect(mocks.setDictationPreferredMic).toHaveBeenCalledWith('mic-2'));
    await act(async () => providerWrite.reject(new Error('provider save failed')));

    expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai');
    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-2');
  });

  it('does not let an older microphone failure roll back a newer successful intent', async () => {
    const older = deferred<void>();
    mocks.setDictationPreferredMic
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(undefined);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-1'));

    fireEvent.click(screen.getByRole('button', { name: 'select-mic-2' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-mic-3' }));
    await waitFor(() => expect(mocks.setDictationPreferredMic).toHaveBeenCalledTimes(2));
    await act(async () => older.reject(new Error('older save failed')));

    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-3');
  });

  it('invalidates an older load before it can overwrite a newer provider intent', async () => {
    const pendingLoad = deferred<{
      revision: number;
      provider: 'openai';
      preferredMic: string;
    }>();
    mocks.readDictationSettings.mockReturnValue(pendingLoad.promise);
    render(<DictationSettings />);
    await waitFor(() => expect(mocks.readDictationSettings).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    await waitFor(() => expect(mocks.setDictationProvider).toHaveBeenCalledWith('groq'));
    await act(async () =>
      pendingLoad.resolve({ revision: 2, provider: 'openai', preferredMic: 'late-mic' })
    );

    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Groq'));
  });

  it('applies a pending load provider and microphone while preserving newer refreshed status', async () => {
    const pendingLoad = deferred<{
      revision: number;
      provider: 'groq';
      preferredMic: string;
    }>();
    const refreshedStatuses = {
      ...providerStatuses,
      groq: { ...providerStatuses.groq, configured: true },
    };
    mocks.readDictationSettings.mockReturnValue(pendingLoad.promise);
    mocks.getDictationConfig
      .mockResolvedValueOnce(refreshedStatuses)
      .mockResolvedValueOnce(providerStatuses);
    render(<DictationSettings />);
    await waitFor(() => expect(mocks.readDictationSettings).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'refresh-statuses' }));
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1));
    await act(async () =>
      pendingLoad.resolve({ revision: 2, provider: 'groq', preferredMic: 'mic-3' })
    );

    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Groq'));
    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-3');
    expect(screen.getByRole('button', { name: 'Update API Key' })).toBeEnabled();
  });

  it('invalidates older provider and microphone rollbacks when a newer load succeeds', async () => {
    const providerWrite = deferred<void>();
    const micWrite = deferred<void>();
    mocks.useFeatures.mockReturnValue({ localInference: false, isLoading: false });
    mocks.readDictationSettings
      .mockResolvedValueOnce({ revision: 1, provider: 'openai', preferredMic: 'mic-1' })
      .mockResolvedValueOnce({ revision: 2, provider: 'local', preferredMic: 'mic-3' });
    mocks.setDictationProvider.mockReturnValue(providerWrite.promise);
    mocks.setDictationPreferredMic.mockReturnValue(micWrite.promise);
    const { rerender } = render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-mic-2' }));
    mocks.useFeatures.mockReturnValue({ localInference: true, isLoading: false });
    rerender(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Disabled'));

    await act(async () => {
      providerWrite.reject(new Error('old provider write failed'));
      micWrite.reject(new Error('old mic write failed'));
    });

    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Local'));
    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-3');
  });

  it('invalidates old field rollbacks as soon as a new authoritative load starts', async () => {
    const providerWrite = deferred<void>();
    const micWrite = deferred<void>();
    const newLoad = deferred<{
      revision: number;
      provider: 'local';
      preferredMic: string;
    }>();
    mocks.useFeatures.mockReturnValue({ localInference: false, isLoading: false });
    mocks.readDictationSettings
      .mockResolvedValueOnce({ revision: 1, provider: 'openai', preferredMic: 'mic-1' })
      .mockReturnValueOnce(newLoad.promise);
    mocks.setDictationProvider.mockReturnValue(providerWrite.promise);
    mocks.setDictationPreferredMic.mockReturnValue(micWrite.promise);
    const { rerender } = render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-mic-2' }));
    mocks.useFeatures.mockReturnValue({ localInference: true, isLoading: false });
    rerender(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Disabled'));
    expect(mocks.readDictationSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('selected-mic')).not.toBeInTheDocument();

    await act(async () => {
      providerWrite.reject(new Error('old provider write failed'));
      micWrite.reject(new Error('old mic write failed'));
    });

    expect(screen.getByTestId('provider-label')).toHaveTextContent('Disabled');
    expect(screen.queryByTestId('selected-mic')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.readDictationSettings).toHaveBeenCalledTimes(2));

    await act(async () =>
      newLoad.resolve({ revision: 2, provider: 'local', preferredMic: 'mic-3' })
    );
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Local'));
    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-3');
  });

  it('waits for in-flight field mutations before reading post-commit authority', async () => {
    const providerWrite = deferred<void>();
    const micWrite = deferred<void>();
    const releaseReloadRead = deferred<void>();
    let providerCommitted = false;
    let micCommitted = false;
    mocks.useFeatures.mockReturnValue({ localInference: false, isLoading: false });
    mocks.readDictationSettings
      .mockResolvedValueOnce({ revision: 1, provider: 'openai', preferredMic: 'mic-1' })
      .mockImplementationOnce(async () => {
        const snapshot = {
          revision: 2,
          provider: providerCommitted ? ('groq' as const) : ('openai' as const),
          preferredMic: micCommitted ? 'mic-2' : 'mic-1',
        };
        await releaseReloadRead.promise;
        return snapshot;
      });
    mocks.setDictationProvider.mockImplementation(() =>
      providerWrite.promise.then(() => {
        providerCommitted = true;
      })
    );
    mocks.setDictationPreferredMic.mockImplementation(() =>
      micWrite.promise.then(() => {
        micCommitted = true;
      })
    );
    const { rerender } = render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-mic-2' }));
    mocks.useFeatures.mockReturnValue({ localInference: true, isLoading: false });
    rerender(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Disabled'));

    await act(async () => {
      providerWrite.resolve();
      micWrite.resolve();
    });
    await waitFor(() => expect(mocks.readDictationSettings).toHaveBeenCalledTimes(2));
    await act(async () => releaseReloadRead.resolve());

    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Groq'));
    expect(screen.getByTestId('selected-mic')).toHaveTextContent('mic-2');
  });

  it('invalidates an older status refresh after a newer provider intent succeeds', async () => {
    const staleRefresh = deferred<typeof providerStatuses>();
    const initialStatuses = {
      ...providerStatuses,
      groq: { ...providerStatuses.groq, configured: true },
    };
    mocks.getDictationConfig
      .mockResolvedValueOnce(initialStatuses)
      .mockReturnValueOnce(staleRefresh.promise);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Openai'));

    fireEvent.click(screen.getByRole('button', { name: 'refresh-statuses' }));
    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update API Key' })).toBeEnabled()
    );
    await act(async () => staleRefresh.resolve(providerStatuses));

    expect(screen.getByRole('button', { name: 'Update API Key' })).toBeEnabled();
  });

  it('fails closed when authoritative preference loading fails', async () => {
    mocks.readDictationSettings.mockRejectedValue(new Error('preferences unavailable'));
    render(<DictationSettings />);

    await waitFor(() => expect(mocks.readDictationSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Disabled'));
    expect(mocks.getDictationConfig).not.toHaveBeenCalled();
    expect(mocks.useConfig).not.toHaveBeenCalled();
  });

  it('fails closed when authoritative dictation config loading fails', async () => {
    mocks.getDictationConfig.mockRejectedValue(new Error('dictation config unavailable'));
    render(<DictationSettings />);

    await waitFor(() => expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('provider-label')).toHaveTextContent('Disabled'));
    expect(screen.queryByTestId('selected-mic')).not.toBeInTheDocument();
  });

  it('ignores a preference load that resolves after unmount', async () => {
    const pending = deferred<{
      revision: number;
      provider: 'openai';
      preferredMic: string;
    }>();
    mocks.readDictationSettings.mockReturnValue(pending.promise);
    const { unmount } = render(<DictationSettings />);
    await waitFor(() => expect(mocks.readDictationSettings).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () =>
      pending.resolve({ revision: 2, provider: 'openai', preferredMic: 'late-mic' })
    );

    expect(mocks.getDictationConfig).not.toHaveBeenCalled();
    expect(mocks.setDictationProvider).not.toHaveBeenCalled();
    expect(mocks.setDictationPreferredMic).not.toHaveBeenCalled();
  });

  it('saves and deletes provider secrets only through typed dictation endpoints', async () => {
    const configuredStatuses = {
      ...providerStatuses,
      openai: { ...providerStatuses.openai, configured: true },
    };
    mocks.getDictationConfig
      .mockResolvedValueOnce(providerStatuses)
      .mockResolvedValueOnce(configuredStatuses)
      .mockResolvedValue(configuredStatuses);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add API Key' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Add API Key' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: '  secret-value  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.saveDictationSecret).toHaveBeenCalledWith('openai', 'secret-value')
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove API Key' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove API Key' }));
    await waitFor(() => expect(mocks.deleteDictationSecret).toHaveBeenCalledWith('openai'));

    expect(mocks.useConfig).not.toHaveBeenCalled();
    expect(genericUpsert).not.toHaveBeenCalled();
    expect(genericRemove).not.toHaveBeenCalled();
  });

  it('clears an API key draft when its bound provider changes and cannot submit it', async () => {
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add API Key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add API Key' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: 'openai-secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));

    expect(screen.queryByPlaceholderText('Enter your API key')).not.toBeInTheDocument();
    expect(mocks.saveDictationSecret).not.toHaveBeenCalled();
  });

  it('does not let an older secret save close or clear a newer provider editor', async () => {
    const olderSave = deferred<void>();
    mocks.saveDictationSecret.mockReturnValueOnce(olderSave.promise);
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add API Key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add API Key' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: 'openai-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.saveDictationSecret).toHaveBeenCalledWith('openai', 'openai-secret')
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-groq' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add API Key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add API Key' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: 'groq-secret' },
    });
    await act(async () => olderSave.resolve());

    expect(screen.getByPlaceholderText('Enter your API key')).toHaveValue('groq-secret');
  });

  it('preserves the draft and editor when a typed secret save rejects', async () => {
    mocks.saveDictationSecret.mockRejectedValue(new Error('secret save unavailable'));
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add API Key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add API Key' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: 'keep-this-draft' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.saveDictationSecret).toHaveBeenCalledTimes(1));
    expect(screen.getByPlaceholderText('Enter your API key')).toHaveValue('keep-this-draft');
    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1);
  });

  it('does not call the typed secret endpoint for a blank API key', async () => {
    render(<DictationSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add API Key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add API Key' }));
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: '   ' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.saveDictationSecret).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Enter your API key')).toHaveValue('   ');
  });

  it('preserves configured status when a typed secret delete rejects', async () => {
    const configuredStatuses = {
      ...providerStatuses,
      openai: { ...providerStatuses.openai, configured: true },
    };
    mocks.getDictationConfig.mockResolvedValue(configuredStatuses);
    mocks.deleteDictationSecret.mockRejectedValue(new Error('secret delete unavailable'));
    render(<DictationSettings />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove API Key' })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove API Key' }));

    await waitFor(() => expect(mocks.deleteDictationSecret).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Remove API Key' })).toBeEnabled();
    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(1);
  });
});
