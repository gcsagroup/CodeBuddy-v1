import { useEffect, useState } from 'react';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { acpListProviderModels } from '../../../acp/providers';
import { defineMessages, useIntl } from '../../../i18n';
import type { ProviderDetails } from '../../../types/providers';
import { Button } from '../../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';

const key = 'subagentTemplates';
const roles = ['explorer', 'browser', 'generic'] as const;
type Role = (typeof roles)[number];
type ModelChoice = { providerId: string; modelId: string } | null;
type Settings = { version: 1; models: Record<Role, ModelChoice> };
type ModelInventory = Record<string, { models: string[]; failed: boolean }>;
const choiceKey = (choice: ModelChoice) =>
  choice ? JSON.stringify([choice.providerId, choice.modelId]) : '';
const defaults = (): Settings => ({
  version: 1,
  models: { explorer: null, browser: null, generic: null },
});
const messages = defineMessages({
  title: { id: 'subagentTemplates.title', defaultMessage: 'Subagent templates and models' },
  description: {
    id: 'subagentTemplates.description',
    defaultMessage:
      'Two default templates are available on demand. Other responsibilities are created and reused within the current chat.',
  },
  explorer: {
    id: 'subagentTemplates.explorer',
    defaultMessage: 'explorer · Workspace exploration',
  },
  browser: {
    id: 'subagentTemplates.browser',
    defaultMessage: 'browser · Web and browser research',
  },
  generic: { id: 'subagentTemplates.generic', defaultMessage: 'Other chat-local responsibilities' },
  boundary: {
    id: 'subagentTemplates.boundary',
    defaultMessage:
      'Models apply to new subagents. Existing subagents keep their model and history. Different chats share templates, not conversation history.',
  },
  provider: { id: 'subagentTemplates.provider', defaultMessage: 'Model connection' },
  model: { id: 'subagentTemplates.model', defaultMessage: 'Model' },
  inherit: { id: 'subagentTemplates.inherit', defaultMessage: 'Inherit the main agent model' },
  unavailable: {
    id: 'subagentTemplates.unavailable',
    defaultMessage: 'Saved connection unavailable',
  },
  loading: { id: 'subagentTemplates.loading', defaultMessage: 'Loading settings…' },
  error: {
    id: 'subagentTemplates.error',
    defaultMessage: 'Could not load or save settings. Your saved configuration was not changed.',
  },
  modelError: {
    id: 'subagentTemplates.modelError',
    defaultMessage: 'Could not load the model list. Enter a model id or retry.',
  },
  save: { id: 'subagentTemplates.save', defaultMessage: 'Save subagent models' },
  saved: { id: 'subagentTemplates.saved', defaultMessage: 'Saved. Applies to new subagents.' },
  retry: { id: 'subagentTemplates.retry', defaultMessage: 'Retry' },
  custom: {
    id: 'recipeModelSelector.enterModelNotListed',
    defaultMessage: 'Enter a model not listed...',
  },
  back: { id: 'recipeModelSelector.backToModelList', defaultMessage: 'Back to model list' },
});

function ModelPicker({
  role,
  choice,
  providers,
  inventory,
  retry,
  disabled,
  onChange,
}: {
  role: Role;
  choice: ModelChoice;
  providers: ProviderDetails[];
  inventory: ModelInventory;
  retry: () => void;
  disabled: boolean;
  onChange: (value: ModelChoice) => void;
}) {
  const intl = useIntl();
  const [custom, setCustom] = useState(false);
  const providerId = choice?.providerId;
  const selectedProvider = providers.find((provider) => provider.name === providerId);
  const className =
    'h-10 min-w-0 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary';
  const label = intl.formatMessage(messages[role]);
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-text-primary">{label}</legend>
      {custom && choice ? (
        <div className="space-y-1">
          <input
            className={`${className} w-full`}
            aria-label={`${label} ${intl.formatMessage(messages.model)}`}
            placeholder={`${selectedProvider?.metadata.display_name || providerId} · ${intl.formatMessage(messages.model)}`}
            value={choice.modelId}
            onChange={(event) => onChange({ ...choice, modelId: event.target.value })}
          />
          <button
            type="button"
            className="text-xs text-text-secondary underline"
            onClick={() => setCustom(false)}
          >
            {intl.formatMessage(messages.back)}
          </button>
        </div>
      ) : (
        <select
          className={`${className} w-full`}
          aria-label={`${label} ${intl.formatMessage(messages.model)}`}
          value={choiceKey(choice)}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              onChange(null);
              return;
            }
            const [providerId, modelId] = JSON.parse(value) as [string, string];
            onChange({ providerId, modelId });
            setCustom(modelId === '');
          }}
        >
          <option value="">{intl.formatMessage(messages.inherit)}</option>
          {choice &&
            (!selectedProvider || !inventory[choice.providerId]?.models.includes(choice.modelId)) &&
            choice.modelId && (
              <option value={choiceKey(choice)}>
                {choice.modelId} ·{' '}
                {selectedProvider?.metadata.display_name ||
                  `${intl.formatMessage(messages.unavailable)}: ${choice.providerId}`}
              </option>
            )}
          {providers.map((provider) => (
            <optgroup key={provider.name} label={provider.metadata.display_name || provider.name}>
              {(inventory[provider.name]?.models ?? []).map((modelId) => (
                <option key={modelId} value={choiceKey({ providerId: provider.name, modelId })}>
                  {modelId} · {provider.metadata.display_name || provider.name}
                </option>
              ))}
              <option value={choiceKey({ providerId: provider.name, modelId: '' })}>
                {intl.formatMessage(messages.custom)} ·{' '}
                {provider.metadata.display_name || provider.name}
              </option>
            </optgroup>
          ))}
        </select>
      )}
      {providerId && inventory[providerId]?.failed && (
        <p className="text-sm text-text-secondary">
          {intl.formatMessage(messages.modelError)}{' '}
          <button type="button" className="underline" onClick={retry}>
            {intl.formatMessage(messages.retry)}
          </button>
        </p>
      )}
    </fieldset>
  );
}

export default function SubagentTemplateSettings({ providers }: { providers: ProviderDetails[] }) {
  const intl = useIntl();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inventory, setInventory] = useState<ModelInventory>({});
  const [modelAttempt, setModelAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // All three roles share this discovery result; model loading never edits
    // the saved choice, including when a connection disappears or fails.
    void Promise.all(
      providers.map(async (provider) => {
        try {
          const models = await acpListProviderModels(provider.name);
          return [
            provider.name,
            { models: [...new Set(models.map((model) => model.id))], failed: false },
          ] as const;
        } catch {
          return [
            provider.name,
            {
              models: provider.metadata.known_models?.map((model) => model.name) ?? [],
              failed: true,
            },
          ] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setInventory(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [providers, modelAttempt]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus(null);
    void acpReadConfig(key)
      .then((value) => {
        if (cancelled) return;
        if (value === null) {
          setSettings(defaults());
          return;
        }
        const saved = value as Settings;
        if (
          saved?.version !== 1 ||
          !saved.models ||
          roles.some((role) => {
            const model = saved.models[role];
            return (
              model != null &&
              (typeof model.providerId !== 'string' || typeof model.modelId !== 'string')
            );
          })
        )
          throw new Error('Invalid subagent settings');
        setSettings({ version: 1, models: { ...defaults().models, ...saved.models } });
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
  }, [attempt]);
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    try {
      await acpUpsertConfig(key, settings);
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-3">
        <CardTitle>{intl.formatMessage(messages.title)}</CardTitle>
        <CardDescription>{intl.formatMessage(messages.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status">{intl.formatMessage(messages.loading)}</p>}
        {settings &&
          roles.map((role) => (
            <ModelPicker
              key={role}
              role={role}
              choice={settings.models[role]}
              providers={providers}
              inventory={inventory}
              retry={() => setModelAttempt((value) => value + 1)}
              disabled={loading || saving}
              onChange={(choice) => {
                setSettings(
                  (current) =>
                    current && { ...current, models: { ...current.models, [role]: choice } }
                );
                setStatus(null);
              }}
            />
          ))}
        <p className="text-sm text-text-secondary">{intl.formatMessage(messages.boundary)}</p>
        <Button
          variant="outline"
          disabled={
            loading ||
            saving ||
            !settings ||
            roles.some((role) => {
              const selection = settings?.models[role];
              return selection && !selection.modelId.trim();
            })
          }
          onClick={() => void save()}
        >
          {intl.formatMessage(messages.save)}
        </Button>
        {status === 'saved' && (
          <p role="status" className="text-sm text-text-secondary">
            {intl.formatMessage(messages.saved)}
          </p>
        )}
        {status === 'error' && (
          <div role="alert" className="text-sm text-text-secondary">
            {intl.formatMessage(messages.error)}
            {!settings && (
              <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                {intl.formatMessage(messages.retry)}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
