import { useState } from 'react';
import {
  acpCreateCustomProviderFromRequest,
  acpDiscoverCustomProviderModels,
} from '../../acp/providers';
import type { UpdateCustomProviderRequest } from '../../types/providers';
import CustomProviderForm from '../settings/providers/modal/subcomponents/forms/CustomProviderForm';
import { Link } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  connectModel: {
    id: 'providerSelector.connectModel',
    defaultMessage: 'Connect a model',
  },
  connectModelDescription: {
    id: 'providerSelector.connectModelDescription',
    defaultMessage:
      'Enter an Ollama or OpenAI-compatible address to connect a local or self-hosted model.',
  },
});

interface ProviderSelectorProps {
  onConfigured: (providerName: string, modelId?: string) => void | Promise<void>;
  onFirstSelection?: () => void;
}

export default function ProviderSelector({
  onConfigured,
  onFirstSelection,
}: ProviderSelectorProps) {
  const intl = useIntl();
  const [showConnectionForm, setShowConnectionForm] = useState(false);

  const handleConnectClick = () => {
    setShowConnectionForm(true);
    onFirstSelection?.();
  };

  const handleCreateCustomProvider = async (data: UpdateCustomProviderRequest) => {
    const result = await acpCreateCustomProviderFromRequest(data);
    await onConfigured(result.provider_name, data.models[0]);
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleConnectClick}
        className={`mb-6 w-full cursor-pointer rounded-xl border bg-background-muted p-4 text-left transition-all duration-200 hover:border-blue-400 ${
          showConnectionForm ? 'border-blue-400' : 'border-border-default'
        }`}
      >
        <Link size={20} className="mb-2 text-text-muted" />
        <span className="block text-base font-medium text-text-default">
          {intl.formatMessage(i18n.connectModel)}
        </span>
        <p className="mt-1 text-sm text-text-muted">
          {intl.formatMessage(i18n.connectModelDescription)}
        </p>
      </button>

      {showConnectionForm && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-300">
          <CustomProviderForm
            initialData={null}
            isEditable
            compactSetup
            discoverModels={acpDiscoverCustomProviderModels}
            onSubmit={handleCreateCustomProvider}
            onCancel={() => setShowConnectionForm(false)}
          />
        </div>
      )}
    </div>
  );
}
