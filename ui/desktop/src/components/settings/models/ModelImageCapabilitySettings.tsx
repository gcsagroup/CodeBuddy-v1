import { SearchableSelect } from '../../ui/SearchableSelect';
import { useEffect, useState } from 'react';
import { acpListProviderModels } from '../../../acp/providers';
import {
  readModelCapabilityOverrides,
  saveModelCapabilityOverrides,
  type ImageInputOverride,
  type ModelCapabilityOverridesConfig,
} from '../../../acp/modelCapabilities';
import type { ProviderDetails } from '../../../types/providers';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';

const messages = defineMessages({
  title: { id: 'modelImageCapability.title', defaultMessage: 'Model image capability correction' },
  description: {
    id: 'modelImageCapability.description',
    defaultMessage:
      'This corrects whether a model accepts image input; it does not select the backup image model or enable vision. Follow service information by default. Override it only after verifying the actual model connection.',
  },
  provider: { id: 'modelImageCapability.provider', defaultMessage: 'Model connection' },
  model: { id: 'modelImageCapability.model', defaultMessage: 'Model' },
  capability: { id: 'modelImageCapability.capability', defaultMessage: 'Image input capability' },
  choose: { id: 'modelImageCapability.choose', defaultMessage: 'Select…' },
  auto: { id: 'modelImageCapability.auto', defaultMessage: 'Follow service information (default)' },
  supported: {
    id: 'modelImageCapability.supported',
    defaultMessage: 'Manually confirmed: accepts images',
  },
  unsupported: {
    id: 'modelImageCapability.unsupported',
    defaultMessage: 'Manually confirmed: text only',
  },
  save: { id: 'modelImageCapability.save', defaultMessage: 'Save capability correction' },
  saved: {
    id: 'modelImageCapability.saved',
    defaultMessage: 'Saved. Applies to the next request.',
  },
  error: {
    id: 'modelImageCapability.error',
    defaultMessage:
      'Could not load or save image capability. Your selection is kept; retry when the connection is available.',
  },
  retry: { id: 'modelImageCapability.retry', defaultMessage: 'Retry loading models' },
  cached: { id: 'modelsBottomBar.cachedList', defaultMessage: 'Showing the last saved list.' },
});

export default function ModelImageCapabilitySettings({
  providers,
}: {
  providers: ProviderDetails[];
}) {
  const intl = useIntl();
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [config, setConfig] = useState<ModelCapabilityOverridesConfig | null>(null);
  const [override, setOverride] = useState<ImageInputOverride>('auto');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [usingSavedList, setUsingSavedList] = useState(false);
  const selectedProvider = providers.find((provider) => provider.name === providerId);

  useEffect(() => {
    let cancelled = false;
    if (!providerId) return;
    setLoading(true);
    setStatus(null);
    setUsingSavedList(false);
    const inventoryRequest = acpListProviderModels(providerId)
      .then((items) => ({ ids: items.map((item) => item.id), cached: false }))
      .catch((error) => {
        const ids = selectedProvider?.metadata.known_models?.map((item) => item.name) ?? [];
        if (!ids.length) throw error;
        return { ids, cached: true };
      });
    void Promise.all([inventoryRequest, readModelCapabilityOverrides()])
      .then(([inventory, saved]) => {
        if (cancelled) return;
        setModels(inventory.ids);
        setUsingSavedList(inventory.cached);
        setConfig(saved);
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, loadAttempt, selectedProvider]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      // Read current settings to retain declarations saved for other models since this panel opened.
      const latest = await readModelCapabilityOverrides();
      const next: ModelCapabilityOverridesConfig = {
        version: 1,
        overrides: [
          ...latest.overrides.filter(
            (item) => item.providerId !== providerId || item.modelId !== modelId
          ),
          { providerId, modelId, imageInput: override },
        ],
      };
      await saveModelCapabilityOverrides(next);
      setConfig(next);
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };
  const selectClass =
    'h-10 min-w-0 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary';
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-3">
        <CardTitle>{intl.formatMessage(messages.title)}</CardTitle>
        <CardDescription>{intl.formatMessage(messages.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-sm text-text-secondary">
            <span className="block">{intl.formatMessage(messages.provider)}</span>
            <SearchableSelect
              aria-label={intl.formatMessage(messages.provider)}
              className={`${selectClass} w-full`}
              value={providerId}
              disabled={saving}
              onValueChange={(nextValue) => {
                setProviderId(nextValue);
                setModelId('');
                setModels([]);
                setConfig(null);
                setStatus(null);
              }}
            >
              <option value="">{intl.formatMessage(messages.choose)}</option>
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.metadata.display_name || provider.name}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="space-y-1 text-sm text-text-secondary">
            <span className="block">{intl.formatMessage(messages.model)}</span>
            <SearchableSelect
              aria-label={intl.formatMessage(messages.model)}
              className={`${selectClass} w-full`}
              value={modelId}
              disabled={saving || loading || !config}
              onValueChange={(nextValue) => {
                const id = nextValue;
                setModelId(id);
                setOverride(
                  config?.overrides.find(
                    (item) => item.providerId === providerId && item.modelId === id
                  )?.imageInput ?? 'auto'
                );
                setStatus(null);
              }}
            >
              <option value="">{intl.formatMessage(messages.choose)}</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="space-y-1 text-sm text-text-secondary">
            <span className="block">{intl.formatMessage(messages.capability)}</span>
            <select
              aria-label={intl.formatMessage(messages.capability)}
              className={`${selectClass} w-full`}
              value={override}
              disabled={saving || !modelId}
              onChange={(event) => {
                setOverride(event.target.value as ImageInputOverride);
                setStatus(null);
              }}
            >
              <option value="auto">{intl.formatMessage(messages.auto)}</option>
              <option value="force_supported">{intl.formatMessage(messages.supported)}</option>
              <option value="force_unsupported">{intl.formatMessage(messages.unsupported)}</option>
            </select>
          </label>
        </div>
        <Button
          variant="outline"
          disabled={saving || loading || !modelId || !config}
          onClick={() => void save()}
        >
          {intl.formatMessage(messages.save)}
        </Button>
        {usingSavedList && <p className="text-sm">{intl.formatMessage(messages.cached)}</p>}
        {((status === 'error' && !config) || usingSavedList) && (
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setLoadAttempt((value) => value + 1)}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        )}
        {status && (
          <p role={status === 'error' ? 'alert' : 'status'} className="text-sm">
            {intl.formatMessage(messages[status])}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
