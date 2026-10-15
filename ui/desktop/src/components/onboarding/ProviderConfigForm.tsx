import { useState } from 'react';
import { acpAuthenticateProvider, acpListProviderModels } from '../../acp/providers';
import type { ProviderDetails } from '../../types/providers';
import DefaultProviderSetupForm, {
  ConfigInput,
} from '../settings/providers/modal/subcomponents/forms/DefaultProviderSetupForm';
import { providerConfigSubmitHandler } from '../settings/providers/modal/subcomponents/handlers/DefaultSubmitHandler';
import {
  isRequiredProviderFieldSatisfied,
  resolvedNonSecretConfigValues,
} from '../settings/providers/modal/providerConfigPolicy';
import ProviderLogo from '../settings/providers/modal/subcomponents/ProviderLogo';
import { SecureStorageNotice } from '../settings/providers/modal/subcomponents/SecureStorageNotice';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/Select';
import { LogIn, ChevronRight } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { errorMessage } from '../../utils/conversionUtils';

type OnConfigured = (name: string, modelId?: string) => void | Promise<void>;
type SetError = (message: string | null) => void;

type ModelOption = {
  value: string;
  label: string;
};

const OLLAMA_CLOUD_PROVIDER = 'ollama_cloud';

const i18n = defineMessages({
  browserWindowOpen: {
    id: 'providerConfigForm.browserWindowOpen',
    defaultMessage: 'A browser window will open for you to complete the login.',
  },
  deviceCodeFlowHint: {
    id: 'providerConfigForm.deviceCodeFlowHint',
    defaultMessage:
      'A browser window will open and the verification code will be copied to your clipboard. Paste it in the browser to complete sign-in.',
  },
  signingIn: {
    id: 'providerConfigForm.signingIn',
    defaultMessage: 'Signing in...',
  },
  signInWith: {
    id: 'providerConfigForm.signInWith',
    defaultMessage: 'Sign in with {providerName}',
  },
  noApiKey: {
    id: 'providerConfigForm.noApiKey',
    defaultMessage: "Don't have an API key?",
  },
  configuring: {
    id: 'providerConfigForm.configuring',
    defaultMessage: 'Configuring...',
  },
  continue: {
    id: 'providerConfigForm.continue',
    defaultMessage: 'Continue',
  },
  loadingModels: {
    id: 'switchModelModal.loadingModels',
    defaultMessage: 'Loading models…',
  },
  chooseModel: {
    id: 'switchModelModal.chooseModel',
    defaultMessage: 'Choose a model:',
  },
  selectModel: {
    id: 'recipeModelSelector.selectModel',
    defaultMessage: 'Select a model',
  },
  customModelName: {
    id: 'switchModelModal.customModelName',
    defaultMessage: 'Custom model name',
  },
  enterModelNotListed: {
    id: 'switchModelModal.enterModelNotListed',
    defaultMessage: 'Enter a model not listed...',
  },
  selectOrEnterModel: {
    id: 'switchModelModal.selectOrEnterModel',
    defaultMessage: 'Please select or enter a model',
  },
  fetchModelsError: {
    id: 'recipeModelSelector.fetchError',
    defaultMessage: 'Failed to fetch models. Please try again later.',
  },
  noModels: {
    id: 'localInferenceSettings.noModels',
    defaultMessage: 'No models available',
  },
  retry: {
    id: 'onboardingGuard.retry',
    defaultMessage: 'Retry',
  },
});

function parseLinks(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          window.electron.openExternal(part);
        }}
        className="underline hover:text-text-default cursor-pointer"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

function OAuthForm({
  provider,
  onConfigured,
  onError,
}: {
  provider: ProviderDetails;
  onConfigured: OnConfigured;
  onError: SetError;
}) {
  const intl = useIntl();
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      await acpAuthenticateProvider(provider.name);
      await onConfigured(provider.name);
    } catch (err) {
      onError(`Setup failed: ${errorMessage(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const isDeviceCodeFlow = provider.metadata.config_keys.some((key) => key.device_code_flow);

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <Button
        onClick={handleLogin}
        disabled={isLoading}
        className="flex items-center gap-2 px-6 py-3"
        size="lg"
      >
        <LogIn size={20} />
        {isLoading
          ? intl.formatMessage(i18n.signingIn)
          : intl.formatMessage(i18n.signInWith, { providerName: provider.metadata.display_name })}
      </Button>
      <p className="text-xs text-text-muted text-center">
        {isDeviceCodeFlow
          ? intl.formatMessage(i18n.deviceCodeFlowHint)
          : intl.formatMessage(i18n.browserWindowOpen)}
      </p>
    </div>
  );
}

function ApiKeyForm({
  provider,
  onConfigured,
  onError,
}: {
  provider: ProviderDetails;
  onConfigured: OnConfigured;
  onError: SetError;
}) {
  const intl = useIntl();
  const [configValues, setConfigValues] = useState<Record<string, ConfigInput>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelLoadFailed, setModelLoadFailed] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [customModel, setCustomModel] = useState('');
  const [showSetupHelp, setShowSetupHelp] = useState(false);
  const setupSteps = provider.metadata.setup_steps;
  const requiresLiveModel = provider.name === OLLAMA_CLOUD_PROVIDER;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationErrors({});
    onError(null);

    if (requiresLiveModel && modelOptions) {
      const resolvedModel = (customModel || selectedModel?.value || '').trim();
      if (!resolvedModel) {
        onError(intl.formatMessage(i18n.selectOrEnterModel));
        return;
      }

      setIsSubmitting(true);
      try {
        await onConfigured(provider.name, resolvedModel);
      } catch (err) {
        onError(errorMessage(err));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const parameters = provider.metadata.config_keys || [];
    const errors: Record<string, string> = {};
    parameters.forEach((param) => {
      if (
        param.required &&
        !isRequiredProviderFieldSatisfied(provider.name, param.name, configValues)
      ) {
        errors[param.name] = `${param.name} is required`;
      }
    });

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    const toSubmit = resolvedNonSecretConfigValues(configValues);

    setIsSubmitting(true);
    setModelLoadFailed(false);
    try {
      await providerConfigSubmitHandler(provider, toSubmit);
      if (requiresLiveModel) {
        setIsLoadingModels(true);
        try {
          const liveModels = await acpListProviderModels(provider.name);
          const options = liveModels
            .map((model) => model.id.trim())
            .filter(Boolean)
            .map((modelId) => ({ value: modelId, label: modelId }));

          if (options.length === 0) {
            setModelOptions([]);
            setSelectedModel(null);
            setCustomModel('');
            setModelLoadFailed(true);
            onError(intl.formatMessage(i18n.noModels));
            return;
          }

          setModelOptions(options);
          setSelectedModel(null);
          setCustomModel('');
        } catch {
          console.error(`Failed to fetch models for ${provider.name}`);
          setModelLoadFailed(true);
          onError(intl.formatMessage(i18n.fetchModelsError));
        } finally {
          setIsLoadingModels(false);
        }
        return;
      }

      await onConfigured(provider.name);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {modelOptions ? (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              {intl.formatMessage(i18n.chooseModel)}
            </label>
            <Select
              aria-label={intl.formatMessage(i18n.selectModel)}
              options={modelOptions}
              value={selectedModel}
              onChange={(option) => {
                setSelectedModel(option as ModelOption | null);
                setCustomModel('');
                onError(null);
              }}
              placeholder={intl.formatMessage(i18n.selectModel)}
              isClearable
              isSearchable
            />
          </div>
          <div>
            <label
              htmlFor="ollama-cloud-custom-model"
              className="mb-1 block text-sm font-medium text-text-primary"
            >
              {intl.formatMessage(i18n.customModelName)}
            </label>
            <Input
              id="ollama-cloud-custom-model"
              aria-label={intl.formatMessage(i18n.customModelName)}
              value={customModel}
              onChange={(event) => {
                setCustomModel(event.target.value);
                setSelectedModel(null);
                onError(null);
              }}
              placeholder={intl.formatMessage(i18n.enterModelNotListed)}
            />
          </div>
        </div>
      ) : (
        <>
          <DefaultProviderSetupForm
            configValues={configValues}
            setConfigValues={setConfigValues}
            provider={provider}
            validationErrors={validationErrors}
            showOptions={false}
          />
          {provider.metadata.config_keys.some((k) => k.required && k.secret) && (
            <SecureStorageNotice />
          )}
          {setupSteps && setupSteps.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowSetupHelp(!showSetupHelp)}
                className="flex items-center gap-1 text-sm text-text-muted hover:text-text-default transition-colors"
              >
                <ChevronRight
                  size={14}
                  className={`transition-transform duration-200 ${showSetupHelp ? 'rotate-90' : ''}`}
                />
                {intl.formatMessage(i18n.noApiKey)}
              </button>
              {showSetupHelp && (
                <ol className="mt-2 ml-5 list-decimal text-sm text-text-muted space-y-1">
                  {setupSteps.map((step, i) => (
                    <li key={i}>{parseLinks(step)}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </>
      )}
      <div className="mt-4">
        <Button type="submit" disabled={isSubmitting || isLoadingModels} className="w-full">
          {isLoadingModels
            ? intl.formatMessage(i18n.loadingModels)
            : isSubmitting
              ? intl.formatMessage(i18n.configuring)
              : modelLoadFailed && !modelOptions
                ? intl.formatMessage(i18n.retry)
                : intl.formatMessage(i18n.continue)}
        </Button>
      </div>
    </form>
  );
}

interface ProviderConfigFormProps {
  provider: ProviderDetails;
  onConfigured: OnConfigured;
}

export default function ProviderConfigForm({ provider, onConfigured }: ProviderConfigFormProps) {
  const [error, setError] = useState<string | null>(null);

  const isOAuthProvider = provider.metadata.config_keys.some((key) => key.oauth_flow);
  const validationUnavailableReason = provider.metadata.config_keys.find(
    (key) =>
      key.primary && key.secret && !key.oauth_flow && key.credential_validation_supported === false
  )?.credential_validation_unavailable_reason;

  const renderForm = () => {
    if (isOAuthProvider) {
      return <OAuthForm provider={provider} onConfigured={onConfigured} onError={setError} />;
    }
    return <ApiKeyForm provider={provider} onConfigured={onConfigured} onError={setError} />;
  };

  return (
    <div>
      <div className="p-4 border rounded-xl bg-background-muted">
        <div className="flex items-center gap-3 mb-4">
          <ProviderLogo providerName={provider.name} />
          <div>
            <h3 className="font-medium text-text-default">{provider.metadata.display_name}</h3>
            <p className="text-xs text-text-muted">{provider.metadata.description}</p>
          </div>
        </div>

        {validationUnavailableReason ? (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-200 dark:border-red-800 text-sm"
          >
            {validationUnavailableReason}
          </div>
        ) : (
          renderForm()
        )}

        {error && (
          <div className="mt-3 p-3 rounded-lg bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-200 dark:border-red-800 text-sm">
            <span role="alert">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
