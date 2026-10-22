import { useEffect, useId, useState } from 'react';
import { ArrowLeft, Bot, ChevronRight } from 'lucide-react';
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
type CustomTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: ModelChoice;
  tools: 'read-only' | 'none' | null;
};
type Settings = { version: 1; models: Record<Role, ModelChoice>; custom?: CustomTemplate[] };
type Editor =
  | { kind: 'custom'; template: CustomTemplate }
  | { kind: 'builtin'; role: Role; model: ModelChoice };
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
      'Use the default templates or save a custom responsibility. Subagents are created only when needed.',
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
      'Changes apply to new subagents. Existing subagents keep their instructions, tools, model and history. Templates are shared across chats; conversation history is not.',
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
  save: { id: 'subagentTemplates.save', defaultMessage: 'Save subagent settings' },
  saved: { id: 'subagentTemplates.saved', defaultMessage: 'Saved. Applies to new subagents.' },
  retry: { id: 'subagentTemplates.retry', defaultMessage: 'Retry' },
  custom: {
    id: 'recipeModelSelector.enterModelNotListed',
    defaultMessage: 'Enter a model not listed...',
  },
  back: { id: 'recipeModelSelector.backToModelList', defaultMessage: 'Back to model list' },
  customTitle: { id: 'subagentTemplates.customTitle', defaultMessage: 'Custom subagents' },
  defaults: { id: 'subagentTemplates.defaults', defaultMessage: 'Default subagents' },
  cancel: { id: 'authSettings.cancel', defaultMessage: 'Cancel' },
  backToList: { id: 'promptsSettings.backToList', defaultMessage: 'Back to List' },
  unsavedBack: {
    id: 'promptsSettings.confirmUnsavedBack',
    defaultMessage: 'You have unsaved changes. Are you sure you want to go back?',
  },
  confirmRemove: {
    id: 'subagentTemplates.confirmRemove',
    defaultMessage: 'Remove this template? Existing subagents and their history will remain.',
  },
  add: { id: 'subagentTemplates.add', defaultMessage: 'Add subagent' },
  name: { id: 'subagentTemplates.name', defaultMessage: 'Name' },
  prompt: { id: 'subagentTemplates.prompt', defaultMessage: 'Prompt' },
  promptHint: {
    id: 'subagentTemplates.promptHint',
    defaultMessage: 'Describe its role, approach and expected output.',
  },
  remove: { id: 'subagentTemplates.remove', defaultMessage: 'Remove template' },
  unnamed: { id: 'subagentTemplates.unnamed', defaultMessage: 'New subagent' },
  invalid: {
    id: 'subagentTemplates.invalid',
    defaultMessage: 'Enter a unique name and a prompt.',
  },
});

function validCustom(templates: CustomTemplate[]) {
  const names = templates.map((template) => template.name.trim().toLowerCase());
  return (
    templates.length <= 16 &&
    new Set(names).size === names.length &&
    templates.every(
      (template) =>
        template.name.trim() &&
        template.name.length <= 80 &&
        !roles.some((role) => role === template.name.trim().toLowerCase()) &&
        template.description.length <= 512 &&
        template.prompt.trim() &&
        template.prompt.length <= 8000 &&
        (!template.model || template.model.modelId.trim())
    )
  );
}

function CustomTemplateEditor({
  template,
  disabled,
  onChange,
  children,
  footer,
}: {
  template: CustomTemplate;
  disabled: boolean;
  onChange: (template: CustomTemplate) => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const intl = useIntl();
  const id = useId();
  const fieldClass =
    'w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm text-text-primary';
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-3 rounded-lg border border-border-primary p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{intl.formatMessage(messages.name)}</span>
          <input
            className={fieldClass}
            maxLength={80}
            value={template.name}
            onChange={(event) => onChange({ ...template, name: event.target.value })}
          />
        </label>
        {children}
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-prompt`} className="text-sm">
          {intl.formatMessage(messages.prompt)}
        </label>
        <textarea
          id={`${id}-prompt`}
          aria-describedby={`${id}-hint`}
          className={`${fieldClass} min-h-32 resize-y`}
          rows={5}
          maxLength={8000}
          value={template.prompt}
          onChange={(event) =>
            onChange({
              ...template,
              prompt: event.target.value,
              // The catalog summary follows the prompt; it is not a separate user setting.
              description: event.target.value.trim().slice(0, 512),
            })
          }
        />
        <p id={`${id}-hint`} className="text-xs text-text-secondary">
          {intl.formatMessage(messages.promptHint)}
        </p>
      </div>
      {footer}
    </fieldset>
  );
}

function ModelPicker({
  label,
  choice,
  providers,
  inventory,
  retry,
  disabled,
  onChange,
}: {
  label?: string;
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
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-text-primary">
        {label || intl.formatMessage(messages.model)}
      </legend>
      {custom && choice ? (
        <div className="space-y-1">
          <input
            className={`${className} w-full`}
            aria-label={[label, intl.formatMessage(messages.model)].filter(Boolean).join(' ')}
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
          aria-label={[label, intl.formatMessage(messages.model)].filter(Boolean).join(' ')}
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

export default function SubagentTemplateSettings({
  providers,
  onDirtyChange,
}: {
  providers: ProviderDetails[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const intl = useIntl();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inventory, setInventory] = useState<ModelInventory>({});
  const [modelAttempt, setModelAttempt] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const original =
    editor?.kind === 'custom'
      ? settings?.custom?.find((item) => item.id === editor.template.id)
      : null;
  const dirty =
    editor?.kind === 'custom'
      ? JSON.stringify(original) !== JSON.stringify(editor.template)
      : editor?.kind === 'builtin' &&
        choiceKey(editor.model) !== choiceKey(settings?.models[editor.role] ?? null);
  useEffect(() => {
    onDirtyChange?.(Boolean(dirty));
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    let cancelled = false;
    // All templates share this discovery result; model loading never edits
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
        if (
          saved.custom !== undefined &&
          (!Array.isArray(saved.custom) ||
            saved.custom.some(
              (template) =>
                !template ||
                typeof template.id !== 'string' ||
                (['name', 'description', 'prompt'] as const).some(
                  (field) => typeof template[field] !== 'string'
                ) ||
                (template.model != null &&
                  (typeof template.model.providerId !== 'string' ||
                    typeof template.model.modelId !== 'string')) ||
                (template.tools != null && !['read-only', 'none'].includes(template.tools))
            ))
        )
          throw new Error('Invalid custom subagent settings');
        setSettings({
          ...saved,
          models: { ...defaults().models, ...saved.models },
          ...(saved.custom
            ? {
                custom: saved.custom.map((template) => ({
                  ...template,
                  model: template.model ?? null,
                  tools: template.tools ?? null,
                })),
              }
            : {}),
        });
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
  const persist = async (next: Settings) => {
    setSaving(true);
    setStatus(null);
    try {
      await acpUpsertConfig(key, next);
      setSettings(next);
      setEditor(null);
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };
  const next =
    settings &&
    editor &&
    (() => {
      if (editor.kind === 'builtin')
        return { ...settings, models: { ...settings.models, [editor.role]: editor.model } };
      const template = {
        ...editor.template,
        name: editor.template.name.trim(),
        prompt: editor.template.prompt.trim(),
        description:
          editor.template.description.trim() || editor.template.prompt.trim().slice(0, 512),
      };
      return {
        ...settings,
        custom: original
          ? settings.custom!.map((item) => (item.id === template.id ? template : item))
          : [...(settings.custom ?? []), template],
      };
    })();
  const valid =
    next &&
    validCustom(next.custom ?? []) &&
    roles.every((role) => !next.models[role] || next.models[role]!.modelId.trim());
  const footer = (
    <div className="flex flex-wrap items-center gap-3 border-t border-border-primary pt-4">
      {original && (
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            if (window.confirm(intl.formatMessage(messages.confirmRemove))) {
              void persist({
                ...settings!,
                custom: settings!.custom!.filter((item) => item.id !== original.id),
              });
            }
          }}
        >
          {intl.formatMessage(messages.remove)}
        </Button>
      )}
      <div className="ml-auto flex gap-3">
        <Button
          variant="outline"
          disabled={saving}
          onClick={() => {
            setEditor(null);
            setStatus(null);
          }}
        >
          {intl.formatMessage(messages.cancel)}
        </Button>
        <Button disabled={saving || !valid || !dirty} onClick={() => next && void persist(next)}>
          {intl.formatMessage(messages.save)}
        </Button>
      </div>
    </div>
  );
  const modelPicker = editor && (
    <ModelPicker
      choice={editor.kind === 'custom' ? editor.template.model : editor.model}
      providers={providers}
      inventory={inventory}
      retry={() => setModelAttempt((value) => value + 1)}
      disabled={saving}
      onChange={(model) => {
        setEditor(
          editor.kind === 'custom'
            ? { ...editor, template: { ...editor.template, model } }
            : { ...editor, model }
        );
        setStatus(null);
      }}
    />
  );
  const modelSummary = (model: ModelChoice) =>
    model
      ? `${model.modelId} · ${providers.find((provider) => provider.name === model.providerId)?.metadata.display_name || model.providerId}`
      : intl.formatMessage(messages.inherit);
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-3">
        {editor && (
          <button
            type="button"
            disabled={saving}
            className="mb-3 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary"
            onClick={() => {
              if (!dirty || window.confirm(intl.formatMessage(messages.unsavedBack))) {
                setEditor(null);
                setStatus(null);
              }
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            {intl.formatMessage(messages.backToList)}
          </button>
        )}
        <CardTitle>
          {editor
            ? editor.kind === 'custom'
              ? original?.name || intl.formatMessage(messages.unnamed)
              : intl.formatMessage(messages[editor.role])
            : intl.formatMessage(messages.title)}
        </CardTitle>
        <CardDescription>
          {intl.formatMessage(editor ? messages.boundary : messages.description)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status">{intl.formatMessage(messages.loading)}</p>}
        {settings && !editor && (
          <>
            <section className="space-y-3" aria-label={intl.formatMessage(messages.customTitle)}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{intl.formatMessage(messages.customTitle)}</h3>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(settings.custom?.length ?? 0) >= 16}
                  onClick={() => {
                    setEditor({
                      kind: 'custom',
                      template: {
                        id: window.crypto.randomUUID(),
                        name: '',
                        description: '',
                        prompt: '',
                        model: null,
                        tools: null,
                      },
                    });
                    setStatus(null);
                  }}
                >
                  {intl.formatMessage(messages.add)}
                </Button>
              </div>
              <div className="divide-y divide-border-subtle">
                {settings.custom?.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    aria-label={template.name}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-background-muted/60"
                    onClick={() => {
                      setEditor({ kind: 'custom', template: { ...template } });
                      setStatus(null);
                    }}
                  >
                    <Bot className="h-4 w-4 shrink-0 text-text-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{template.name}</span>
                      <span className="mt-1 block truncate text-xs text-text-secondary">
                        {modelSummary(template.model)}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 text-text-muted" />
                  </button>
                ))}
              </div>
            </section>
            <section className="space-y-2 border-t border-border-subtle pt-4">
              <h3 className="text-sm font-medium">{intl.formatMessage(messages.defaults)}</h3>
              {roles.map((role) => (
                <button
                  key={role}
                  type="button"
                  aria-label={intl.formatMessage(messages[role])}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-3 text-left hover:bg-background-muted/60"
                  onClick={() => {
                    setEditor({ kind: 'builtin', role, model: settings.models[role] });
                    setStatus(null);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block text-sm">{intl.formatMessage(messages[role])}</span>
                    <span className="mt-1 block truncate text-xs text-text-secondary">
                      {modelSummary(settings.models[role])}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                </button>
              ))}
            </section>
          </>
        )}
        {editor?.kind === 'custom' && (
          <CustomTemplateEditor
            key={editor.template.id}
            template={editor.template}
            disabled={saving}
            footer={footer}
            onChange={(template) => {
              setEditor({ kind: 'custom', template });
              setStatus(null);
            }}
          >
            {modelPicker}
          </CustomTemplateEditor>
        )}
        {editor?.kind === 'builtin' && (
          <div className="space-y-4">
            {modelPicker}
            {footer}
          </div>
        )}
        {editor && !valid && (
          <p className="text-xs text-text-secondary">{intl.formatMessage(messages.invalid)}</p>
        )}
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
