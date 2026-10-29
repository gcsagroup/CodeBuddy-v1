import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import Model, { getProviderMetadata } from './settings/models/modelInterface';
import type { ProviderMetadata } from '../types/providers';
import { acpChatSessionActions, acpChatSessionStore } from '../acp/chatSessionStore';
import {
  acpReadDefaults,
  acpSaveDefaults,
  acpSetSessionProviderModel,
  type AppliedSessionProviderModel,
} from '../acp/providers';
import {
  getModelDisplayName,
  getProviderDisplayName,
} from './settings/models/predefinedModelsUtils';
import { defineMessages, useIntl } from '../i18n';
import { acpErrorCode } from '../acp/errors';

const i18n = defineMessages({
  unknownProviderTitle: {
    id: 'modelAndProviderContext.unknownProviderTitle',
    defaultMessage: 'Provider name lookup',
  },
  unknownProviderMsg: {
    id: 'modelAndProviderContext.unknownProviderMsg',
    defaultMessage: 'Unknown provider in config -- please inspect your config.yaml',
  },
  modelChangeFailedMessage: {
    id: 'modelAndProviderContext.modelChangeFailedMessage',
    defaultMessage: 'Unable to switch models. Try again.',
  },
  modelUnavailable: {
    id: 'modelAndProviderContext.modelUnavailable',
    defaultMessage:
      'This model is no longer served by the provider. Refresh the model list and choose an available model.',
  },
  endpointUnreachable: {
    id: 'modelAndProviderContext.endpointUnreachable',
    defaultMessage:
      'The model service could not be reached. Check its address and connection, then retry.',
  },
  credentialsRejected: {
    id: 'modelAndProviderContext.credentialsRejected',
    defaultMessage:
      'The model service rejected or requires credentials. Check this provider in Settings.',
  },
  invalidResponse: {
    id: 'modelAndProviderContext.invalidResponse',
    defaultMessage:
      'The model service returned an invalid response. Check the provider address and API compatibility.',
  },
  selectModel: {
    id: 'modelAndProviderContext.selectModel',
    defaultMessage: 'Select Model',
  },
});

interface ModelAndProviderContextType {
  currentModel: string | null;
  currentProvider: string | null;
  changeModel: (
    sessionId: string | null,
    model: Model,
    options?: { updateDefaults?: boolean; onError?: (message: string) => void }
  ) => Promise<boolean>;
  getCurrentModelAndProvider: () => Promise<{ model: string; provider: string }>;
  getFallbackModelAndProvider: () => Promise<{ model: string; provider: string }>;
  getCurrentModelAndProviderForDisplay: () => Promise<{ model: string; provider: string }>;
  getCurrentModelDisplayName: () => Promise<string>;
  getCurrentProviderDisplayName: () => Promise<string>; // Gets provider display name from subtext
  refreshCurrentModelAndProvider: () => Promise<void>;
}

interface ModelAndProviderProviderProps {
  children: React.ReactNode;
}

const ModelAndProviderContext = createContext<ModelAndProviderContextType | undefined>(undefined);

export { i18n as modelAndProviderMessages };

function patchAcpSessionProviderModel(
  sessionId: string,
  { providerId, modelId }: AppliedSessionProviderModel
) {
  if (!providerId && !modelId) return;

  const currentSession = acpChatSessionStore.getSnapshot(sessionId)?.session;
  if (!currentSession) return;

  acpChatSessionActions.setSessionMetadata(sessionId, {
    ...currentSession,
    provider_name: providerId ?? currentSession.provider_name,
    model_config: modelId
      ? {
          ...(currentSession.model_config ?? { toolshim: false }),
          model_name: modelId,
        }
      : currentSession.model_config,
  });
}

export const ModelAndProviderProvider: React.FC<ModelAndProviderProviderProps> = ({ children }) => {
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentProvider, setCurrentProvider] = useState<string | null>(null);
  const intl = useIntl();

  const changeModel = useCallback(
    async (
      sessionId: string | null,
      model: Model,
      options?: { updateDefaults?: boolean; onError?: (message: string) => void }
    ) => {
      const modelName = model.name;
      const providerName = model.provider;
      let phase = 'agent';
      const previousSession = sessionId
        ? acpChatSessionStore.getSnapshot(sessionId)?.session
        : undefined;

      try {
        if (sessionId) {
          const applied = await acpSetSessionProviderModel(
            sessionId,
            providerName,
            modelName,
            model.request_params?.thinking_effort ?? null
          );
          patchAcpSessionProviderModel(sessionId, applied);
        }

        const shouldUpdateDefaults = !sessionId || options?.updateDefaults === true;
        if (shouldUpdateDefaults) {
          phase = 'config';
          await acpSaveDefaults(providerName, modelName);
          setCurrentProvider(providerName);
          setCurrentModel(modelName);
        }

        return true;
      } catch (error) {
        if (
          phase === 'config' &&
          sessionId &&
          previousSession?.provider_name &&
          previousSession.model_config?.model_name
        ) {
          try {
            const restored = await acpSetSessionProviderModel(
              sessionId,
              previousSession.provider_name,
              previousSession.model_config.model_name,
              null
            );
            patchAcpSessionProviderModel(sessionId, restored);
          } catch {
            console.error('Unable to roll back the session model after the config step failed.');
          }
        }
        console.error(`Unable to change model during the ${phase} step.`);
        const messages: Record<string, typeof i18n.modelChangeFailedMessage> = {
          custom_provider_model_unavailable: i18n.modelUnavailable,
          custom_provider_endpoint_unreachable: i18n.endpointUnreachable,
          custom_provider_invalid_credentials: i18n.credentialsRejected,
          custom_provider_api_key_required: i18n.credentialsRejected,
          custom_provider_credentials_not_verified: i18n.credentialsRejected,
          custom_provider_model_list_unavailable: i18n.invalidResponse,
          custom_provider_invalid_response: i18n.invalidResponse,
          custom_provider_no_models: i18n.modelUnavailable,
        };
        // Translate known server codes only; never expose raw errors, paths or credentials.
        const message = intl.formatMessage(
          messages[acpErrorCode(error) ?? ''] ?? i18n.modelChangeFailedMessage
        );
        options?.onError?.(message);
        return false;
      }
    },
    [intl]
  );

  const getFallbackModelAndProvider = useCallback(async () => {
    return { model: '', provider: '' };
  }, []);

  const getCurrentModelAndProvider = useCallback(async () => {
    let model: string | null;
    let provider: string | null;

    try {
      const defaults = await acpReadDefaults();
      model = defaults.modelId;
      provider = defaults.providerId;
    } catch {
      console.error(`Failed to read default model or provider`);
      throw new Error('Failed to read default model or provider');
    }
    if (!model || !provider) {
      return getFallbackModelAndProvider();
    }
    return { model: model, provider: provider };
  }, [getFallbackModelAndProvider]);

  const getCurrentModelAndProviderForDisplay = useCallback(async () => {
    const modelProvider = await getCurrentModelAndProvider();
    const gooseModel = modelProvider.model;
    const gooseProvider = modelProvider.provider;

    // lookup display name
    let metadata: ProviderMetadata;

    try {
      metadata = await getProviderMetadata(String(gooseProvider));
    } catch {
      return { model: gooseModel, provider: gooseProvider };
    }
    const providerDisplayName = metadata.display_name;

    return { model: gooseModel, provider: providerDisplayName };
  }, [getCurrentModelAndProvider]);

  const getCurrentModelDisplayName = useCallback(async () => {
    try {
      const { modelId } = await acpReadDefaults();
      return getModelDisplayName(modelId ?? '');
    } catch {
      return intl.formatMessage(i18n.selectModel);
    }
  }, [intl]);

  const getCurrentProviderDisplayName = useCallback(async () => {
    try {
      const { modelId } = await acpReadDefaults();
      const providerDisplayName = getProviderDisplayName(modelId ?? '');
      if (providerDisplayName) {
        return providerDisplayName;
      }
      // Fall back to regular provider display name lookup
      const { provider } = await getCurrentModelAndProviderForDisplay();
      return provider;
    } catch {
      return '';
    }
  }, [getCurrentModelAndProviderForDisplay]);

  const refreshCurrentModelAndProvider = useCallback(async () => {
    try {
      const { model, provider } = await getCurrentModelAndProvider();
      setCurrentModel(model);
      setCurrentProvider(provider);
    } catch (_error) {
      console.error('Failed to refresh current model and provider:', _error);
    }
  }, [getCurrentModelAndProvider]);

  // Load initial model and provider on mount
  useEffect(() => {
    refreshCurrentModelAndProvider();
  }, [refreshCurrentModelAndProvider]);

  const contextValue = useMemo(
    () => ({
      currentModel,
      currentProvider,
      changeModel,
      getCurrentModelAndProvider,
      getFallbackModelAndProvider,
      getCurrentModelAndProviderForDisplay,
      getCurrentModelDisplayName,
      getCurrentProviderDisplayName,
      refreshCurrentModelAndProvider,
    }),
    [
      currentModel,
      currentProvider,
      changeModel,
      getCurrentModelAndProvider,
      getFallbackModelAndProvider,
      getCurrentModelAndProviderForDisplay,
      getCurrentModelDisplayName,
      getCurrentProviderDisplayName,
      refreshCurrentModelAndProvider,
    ]
  );

  return (
    <ModelAndProviderContext.Provider value={contextValue}>
      {children}
    </ModelAndProviderContext.Provider>
  );
};

export const useModelAndProvider = () => {
  const context = useContext(ModelAndProviderContext);
  if (context === undefined) {
    throw new Error('useModelAndProvider must be used within a ModelAndProviderProvider');
  }
  return context;
};
