import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  deleteDictationSecret,
  getDictationConfig,
  saveDictationSecret,
  DictationProviderStatusEntry,
} from '../../../acp/dictation';
import { Input } from '../../ui/input';
import { Button } from '../../ui/button';
import { trackSettingToggled } from '../../../utils/analytics';
import { LocalModelManager } from './LocalModelManager';
import { MicrophoneSelector } from './MicrophoneSelector';
import { DICTATION_ALLOWED_PROVIDERS } from '../../../updates';
import { useFeatures } from '../../../contexts/FeaturesContext';
import type { DictationProvider } from '../../../types/dictation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { defineMessages, useIntl } from '../../../i18n';
import {
  readDictationSettings,
  setDictationPreferredMic,
  setDictationProvider,
} from './dictationPreferences';

const i18n = defineMessages({
  voiceDictationProvider: {
    id: 'dictationSettings.voiceDictationProvider',
    defaultMessage: 'Voice Dictation Provider',
  },
  chooseVoiceConversion: {
    id: 'dictationSettings.chooseVoiceConversion',
    defaultMessage: 'Choose how voice is converted to text',
  },
  disabled: {
    id: 'dictationSettings.disabled',
    defaultMessage: 'Disabled',
  },
  notConfigured: {
    id: 'dictationSettings.notConfigured',
    defaultMessage: '(not configured)',
  },
  configureApiKey: {
    id: 'dictationSettings.configureApiKey',
    defaultMessage: 'Configure the API key in <b>{settingsPath}</b>',
  },
  configuredIn: {
    id: 'dictationSettings.configuredIn',
    defaultMessage: '✓ Configured in {settingsPath}',
  },
  apiKey: {
    id: 'dictationSettings.apiKey',
    defaultMessage: 'API Key',
  },
  requiredForTranscription: {
    id: 'dictationSettings.requiredForTranscription',
    defaultMessage: 'Required for transcription',
  },
  configured: {
    id: 'dictationSettings.configured',
    defaultMessage: '(Configured)',
  },
  updateApiKey: {
    id: 'dictationSettings.updateApiKey',
    defaultMessage: 'Update API Key',
  },
  addApiKey: {
    id: 'dictationSettings.addApiKey',
    defaultMessage: 'Add API Key',
  },
  removeApiKey: {
    id: 'dictationSettings.removeApiKey',
    defaultMessage: 'Remove API Key',
  },
  enterApiKey: {
    id: 'dictationSettings.enterApiKey',
    defaultMessage: 'Enter your API key',
  },
  save: {
    id: 'dictationSettings.save',
    defaultMessage: 'Save',
  },
  cancel: {
    id: 'dictationSettings.cancel',
    defaultMessage: 'Cancel',
  },
});

export const DictationSettings = () => {
  const intl = useIntl();
  const { localInference, isLoading: isFeaturesLoading } = useFeatures();
  const [provider, setProvider] = useState<DictationProvider | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<
    Record<string, DictationProviderStatusEntry>
  >({});
  const [preferredMic, setPreferredMic] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [editingProvider, setEditingProvider] = useState<DictationProvider | null>(null);
  const mountedRef = useRef(true);
  const editingProviderRef = useRef<DictationProvider | null>(null);
  const loadEpochRef = useRef(0);
  const providerGenerationRef = useRef(0);
  const micGenerationRef = useRef(0);
  const statusGenerationRef = useRef(0);
  const providerMutationRef = useRef<Promise<void> | null>(null);
  const micMutationRef = useRef<Promise<void> | null>(null);
  const secretEpochRef = useRef(0);
  const isEditingKey = provider !== null && editingProvider === provider;

  const refreshStatuses = useCallback(async () => {
    const generation = ++statusGenerationRef.current;
    try {
      const audioConfig = await getDictationConfig();
      if (mountedRef.current && generation === statusGenerationRef.current) {
        setProviderStatuses(audioConfig);
      }
    } catch {
      if (mountedRef.current && generation === statusGenerationRef.current) {
        setProviderStatuses({});
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const loadEpoch = ++loadEpochRef.current;
    const loadStatusGeneration = ++statusGenerationRef.current;
    const pendingMutations = [providerMutationRef.current, micMutationRef.current].filter(
      (mutation): mutation is Promise<void> => mutation !== null
    );
    providerGenerationRef.current++;
    micGenerationRef.current++;
    secretEpochRef.current++;
    editingProviderRef.current = null;
    setEditingProvider(null);
    setApiKey('');
    setProvider(null);
    setPreferredMic(null);
    setProviderStatuses({});
    if (isFeaturesLoading) return;

    const loadSettings = async () => {
      try {
        await Promise.allSettled(pendingMutations);
        if (!mountedRef.current || loadEpoch !== loadEpochRef.current) return;
        const settings = await readDictationSettings();
        if (!mountedRef.current || loadEpoch !== loadEpochRef.current) return;

        let loadedProvider = settings.provider;
        const mustDisable =
          (DICTATION_ALLOWED_PROVIDERS &&
            loadedProvider &&
            !DICTATION_ALLOWED_PROVIDERS.includes(loadedProvider)) ||
          (!localInference && loadedProvider === 'local');
        if (mustDisable) {
          loadedProvider = null;
          await setDictationProvider(null);
          if (!mountedRef.current || loadEpoch !== loadEpochRef.current) return;
        }

        const audioConfig = await getDictationConfig();
        if (!mountedRef.current || loadEpoch !== loadEpochRef.current) return;
        providerGenerationRef.current++;
        micGenerationRef.current++;
        setProvider(loadedProvider);
        setPreferredMic(settings.preferredMic);
        if (loadStatusGeneration === statusGenerationRef.current) {
          setProviderStatuses(audioConfig);
        }
      } catch {
        if (mountedRef.current && loadEpoch === loadEpochRef.current) {
          providerGenerationRef.current++;
          micGenerationRef.current++;
          setProvider(null);
          setPreferredMic(null);
          if (loadStatusGeneration === statusGenerationRef.current) {
            setProviderStatuses({});
          }
        }
      }
    };

    void loadSettings();
  }, [localInference, isFeaturesLoading]);

  const handleProviderChange = (value: string) => {
    const newProvider = value === 'disabled' ? null : (value as DictationProvider);
    const previousProvider = provider;
    const generation = ++providerGenerationRef.current;
    loadEpochRef.current++;
    statusGenerationRef.current++;
    secretEpochRef.current++;
    editingProviderRef.current = null;
    setEditingProvider(null);
    setApiKey('');
    setProvider(newProvider);
    const mutation = setDictationProvider(newProvider);
    providerMutationRef.current = mutation;
    void mutation.then(
      () => {
        if (providerMutationRef.current === mutation) providerMutationRef.current = null;
      },
      () => {
        if (mountedRef.current && generation === providerGenerationRef.current) {
          setProvider(previousProvider);
        }
        if (providerMutationRef.current === mutation) providerMutationRef.current = null;
      }
    );
    trackSettingToggled('voice_dictation', newProvider !== null);
  };

  const handleMicChange = (deviceId: string | null) => {
    const previousMic = preferredMic;
    const generation = ++micGenerationRef.current;
    loadEpochRef.current++;
    setPreferredMic(deviceId);
    const mutation = setDictationPreferredMic(deviceId);
    micMutationRef.current = mutation;
    void mutation.then(
      () => {
        if (micMutationRef.current === mutation) micMutationRef.current = null;
      },
      () => {
        if (mountedRef.current && generation === micGenerationRef.current) {
          setPreferredMic(previousMic);
        }
        if (micMutationRef.current === mutation) micMutationRef.current = null;
      }
    );
  };

  const handleSaveKey = async () => {
    const boundProvider = editingProviderRef.current;
    if (!provider || !boundProvider || boundProvider !== provider) return;
    const providerConfig = providerStatuses[boundProvider];
    if (!providerConfig || providerConfig.usesProviderConfig) return;

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;

    const epoch = ++secretEpochRef.current;
    try {
      await saveDictationSecret(boundProvider, trimmedKey);
    } catch {
      return;
    }
    if (
      !mountedRef.current ||
      epoch !== secretEpochRef.current ||
      editingProviderRef.current !== boundProvider
    ) {
      return;
    }
    setApiKey('');
    editingProviderRef.current = null;
    setEditingProvider(null);
    await refreshStatuses();
  };

  const handleRemoveKey = async () => {
    const boundProvider = provider;
    if (!boundProvider) return;
    const providerConfig = providerStatuses[boundProvider];
    if (!providerConfig || providerConfig.usesProviderConfig) return;

    const epoch = ++secretEpochRef.current;
    try {
      await deleteDictationSecret(boundProvider);
    } catch {
      return;
    }
    if (!mountedRef.current || epoch !== secretEpochRef.current || provider !== boundProvider) {
      return;
    }
    setApiKey('');
    editingProviderRef.current = null;
    setEditingProvider(null);
    await refreshStatuses();
  };

  const handleCancelEdit = () => {
    secretEpochRef.current++;
    setApiKey('');
    editingProviderRef.current = null;
    setEditingProvider(null);
  };

  const handleStartEdit = () => {
    if (!provider) return;
    secretEpochRef.current++;
    setApiKey('');
    editingProviderRef.current = provider;
    setEditingProvider(provider);
  };

  const getProviderLabel = (p: DictationProvider | null): string => {
    if (!p) return intl.formatMessage(i18n.disabled);
    return p.charAt(0).toUpperCase() + p.slice(1);
  };

  const visibleProviders = (Object.keys(providerStatuses) as DictationProvider[]).filter(
    (p) => !DICTATION_ALLOWED_PROVIDERS || DICTATION_ALLOWED_PROVIDERS.includes(p)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between py-2 px-2 hover:bg-background-secondary rounded-lg transition-all">
        <div>
          <h3 className="text-text-primary">{intl.formatMessage(i18n.voiceDictationProvider)}</h3>
          <p className="text-xs text-text-secondary max-w-md mt-[2px]">
            {intl.formatMessage(i18n.chooseVoiceConversion)}
          </p>
        </div>
        <DropdownMenu onOpenChange={(open) => open && refreshStatuses()}>
          <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border-primary rounded-md hover:border-border-primary transition-colors text-text-primary bg-background-primary">
            {getProviderLabel(provider)}
            <ChevronDown className="w-4 h-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-[250px] max-w-[350px]">
            <DropdownMenuRadioGroup
              value={provider ?? 'disabled'}
              onValueChange={handleProviderChange}
            >
              <DropdownMenuRadioItem value="disabled">
                {intl.formatMessage(i18n.disabled)}
              </DropdownMenuRadioItem>
              {visibleProviders.map((p) => (
                <DropdownMenuRadioItem key={p} value={p}>
                  {getProviderLabel(p)}
                  {!providerStatuses[p]?.configured && (
                    <span className="text-xs ml-1 text-text-secondary">
                      {intl.formatMessage(i18n.notConfigured)}
                    </span>
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {provider && providerStatuses[provider] && (
        <>
          {provider === 'local' ? (
            <div className="py-2 px-2">
              <LocalModelManager />
            </div>
          ) : providerStatuses[provider].usesProviderConfig ? (
            <div className="py-2 px-2 bg-background-secondary rounded-lg">
              {!providerStatuses[provider].configured ? (
                <p className="text-xs text-text-secondary">
                  {intl.formatMessage(i18n.configureApiKey, {
                    settingsPath: providerStatuses[provider].settingsPath,
                    b: (chunks: React.ReactNode) => <b>{chunks}</b>,
                  })}
                </p>
              ) : (
                <p className="text-xs text-green-600">
                  {intl.formatMessage(i18n.configuredIn, {
                    settingsPath: providerStatuses[provider].settingsPath,
                  })}
                </p>
              )}
            </div>
          ) : (
            <div className="py-2 px-2 bg-background-secondary rounded-lg">
              <div className="mb-2">
                <h4 className="text-text-primary text-sm">{intl.formatMessage(i18n.apiKey)}</h4>
                <p className="text-xs text-text-secondary mt-[2px]">
                  {intl.formatMessage(i18n.requiredForTranscription)}
                  {providerStatuses[provider]?.configured && (
                    <span className="text-green-600 ml-2">
                      {intl.formatMessage(i18n.configured)}
                    </span>
                  )}
                </p>
              </div>

              {!isEditingKey ? (
                <div className="flex gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={handleStartEdit}>
                    {providerStatuses[provider]?.configured
                      ? intl.formatMessage(i18n.updateApiKey)
                      : intl.formatMessage(i18n.addApiKey)}
                  </Button>
                  {providerStatuses[provider]?.configured && (
                    <Button variant="destructive" size="sm" onClick={handleRemoveKey}>
                      {intl.formatMessage(i18n.removeApiKey)}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={intl.formatMessage(i18n.enterApiKey)}
                    className="max-w-md"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveKey}>
                      {intl.formatMessage(i18n.save)}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCancelEdit}>
                      {intl.formatMessage(i18n.cancel)}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <MicrophoneSelector selectedDeviceId={preferredMic} onDeviceChange={handleMicChange} />
        </>
      )}
    </div>
  );
};
