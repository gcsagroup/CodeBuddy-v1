import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import type { RecipeSettingsDto } from '@aaif/goose-sdk';
import {
  acpListProviderDetails,
  acpReadDefaults,
  acpReadModelDisplaySettings,
} from '../../acp/providers';
import { acpChatSessionStore } from '../../acp/chatSessionStore';
import { acpGetSessionListItem } from '../../acp/sessions';
import {
  providerActivationDisabledReason,
  type ProviderDetails,
  type ModelThinkingSettings,
} from '../../types/providers';
import { defineMessages, useIntl } from '../../i18n';
import { ThinkingEffortPicker } from '../ThinkingEffortPicker';

const i18n = defineMessages({
  model: { id: 'scheduleModel.model', defaultMessage: 'Model' },
  effort: { id: 'scheduleModel.effort', defaultMessage: 'Effort' },
  defaultModel: { id: 'scheduleModel.defaultModel', defaultMessage: 'Default model' },
  currentChat: { id: 'scheduleModel.currentChat', defaultMessage: 'Follows the current chat' },
  readError: { id: 'scheduleModel.readError', defaultMessage: 'Could not read model settings' },
  loading: { id: 'scheduleModel.loading', defaultMessage: 'Reading…' },
  unavailable: { id: 'thinkingEffortPicker.noControls', defaultMessage: 'No verified controls' },
  empty: { id: 'scheduleModel.empty', defaultMessage: 'No configured models' },
  more: { id: 'scheduleModel.more', defaultMessage: 'Show all models' },
});

interface Props {
  value: RecipeSettingsDto | null | undefined;
  onChange: (value: RecipeSettingsDto) => void;
  followChatId?: string;
}

// Draft controls only: choosing here never changes a chat or global defaults.
export function ScheduleModelControls({ value, onChange, followChatId }: Props) {
  const intl = useIntl();
  const [defaults, setDefaults] = useState<{
    providerId: string | null;
    modelId: string | null;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [thinking, setThinking] = useState<ModelThinkingSettings | null>(null);
  const [thinkingError, setThinkingError] = useState(false);

  useEffect(() => {
    let active = true;
    setDefaults(null);
    const read = followChatId
      ? (async () => {
          const session = acpChatSessionStore.getSnapshot(followChatId)?.session;
          if (session)
            return {
              providerId: session.provider_name ?? null,
              modelId: session.model_config?.model_name ?? null,
            };
          const item = await acpGetSessionListItem(followChatId);
          return { providerId: item.providerId ?? null, modelId: item.modelId ?? null };
        })()
      : acpReadDefaults();
    void read
      .then((selection) => {
        if (active) setDefaults(selection);
      })
      .catch(() => {
        if (active) setDefaults({ providerId: null, modelId: null });
      });
    return () => {
      active = false;
    };
  }, [followChatId]);

  const providerId = followChatId
    ? defaults?.providerId
    : (value?.goose_provider ?? defaults?.providerId);
  const modelId = followChatId ? defaults?.modelId : (value?.goose_model ?? defaults?.modelId);

  useEffect(() => {
    let active = true;
    setThinking(null);
    setThinkingError(false);
    if (providerId && modelId) {
      void acpReadModelDisplaySettings(providerId, modelId)
        .then((settings) => {
          if (active) setThinking(settings.thinking);
        })
        .catch(() => {
          if (active) setThinkingError(true);
        });
    }
    return () => {
      active = false;
    };
  }, [providerId, modelId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setModelsLoading(true);
    setModelsError(false);
    void acpListProviderDetails()
      .then((items) => {
        if (active)
          setProviders(
            items.filter(
              (item) => item.is_configured && providerActivationDisabledReason(item) === null
            )
          );
      })
      .catch(() => {
        if (active) setModelsError(true);
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const override = value?.goose_thinking_effort === 'none' ? 'off' : value?.goose_thinking_effort;
  const displayedThinking: ModelThinkingSettings | null =
    thinking && !followChatId && override && thinking.options.includes(override)
      ? { ...thinking, value: override }
      : thinking;

  return (
    <>
      <div className="flex min-h-12 items-center justify-between gap-4 rounded-2xl border border-border-primary px-4 py-2">
        <span className="text-sm text-text-primary">{intl.formatMessage(i18n.model)}</span>
        <Popover.Root open={open && !followChatId} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={intl.formatMessage(i18n.model)}
              disabled={Boolean(followChatId)}
              title={followChatId ? intl.formatMessage(i18n.currentChat) : undefined}
              className="flex min-w-0 items-center justify-end gap-2 rounded-lg py-1 text-sm text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-primary disabled:cursor-default"
            >
              <span className="truncate">
                {modelId || intl.formatMessage(followChatId ? i18n.currentChat : i18n.defaultModel)}
              </span>
              {!followChatId && <ChevronDown className="size-3.5 shrink-0" />}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="z-[100] max-h-72 w-72 max-w-[calc(100vw-3rem)] overflow-y-auto rounded-2xl border border-border-primary bg-background-primary p-1 text-sm text-text-primary shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
            >
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-background-secondary"
                onClick={() => {
                  onChange({
                    ...value,
                    goose_provider: null,
                    goose_model: null,
                    goose_thinking_effort: null,
                  });
                  setOpen(false);
                }}
              >
                {intl.formatMessage(i18n.defaultModel)}
                {!value?.goose_provider && !value?.goose_model && <Check className="size-3.5" />}
              </button>
              {(modelsLoading || modelsError || !providers.length) && (
                <p
                  role={modelsError ? 'alert' : undefined}
                  className="px-3 py-2 text-xs text-text-secondary"
                >
                  {intl.formatMessage(
                    modelsLoading ? i18n.loading : modelsError ? i18n.readError : i18n.empty
                  )}
                </p>
              )}
              {!modelsLoading &&
                !modelsError &&
                [...providers]
                  .sort((a, b) => Number(b.name === providerId) - Number(a.name === providerId))
                  .map((provider) => (
                    <details key={provider.name} open={provider.name === providerId}>
                      <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs text-text-secondary hover:bg-background-secondary">
                        {provider.metadata.display_name}
                      </summary>
                      {(expanded[provider.name]
                        ? provider.metadata.known_models
                        : provider.metadata.known_models.slice(0, 6)
                      ).map((model) => (
                        <button
                          key={model.name}
                          type="button"
                          className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-background-secondary"
                          onClick={() => {
                            onChange({
                              ...value,
                              goose_provider: provider.name,
                              goose_model: model.name,
                              goose_thinking_effort: null,
                            });
                            setOpen(false);
                          }}
                        >
                          <span className="truncate">{model.name}</span>
                          {provider.name === providerId && model.name === modelId && (
                            <Check className="size-3.5 shrink-0" />
                          )}
                        </button>
                      ))}
                      {!expanded[provider.name] && provider.metadata.known_models.length > 6 && (
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left text-xs text-text-secondary hover:bg-background-secondary"
                          onClick={() =>
                            setExpanded((current) => ({ ...current, [provider.name]: true }))
                          }
                        >
                          {intl.formatMessage(i18n.more)}
                        </button>
                      )}
                    </details>
                  ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <div className="flex min-h-12 items-center justify-between gap-4 rounded-2xl border border-border-primary px-4 py-2">
        <span className="text-sm text-text-primary">{intl.formatMessage(i18n.effort)}</span>
        {displayedThinking && (!displayedThinking.options.length || !displayedThinking.value) ? (
          <span className="text-xs text-text-secondary">
            {intl.formatMessage(i18n.unavailable)}
          </span>
        ) : displayedThinking ? (
          <ThinkingEffortPicker
            settings={displayedThinking}
            showLabel={false}
            disabled={Boolean(followChatId)}
            onChange={(effort) => {
              if (providerId && modelId)
                onChange({
                  ...value,
                  goose_provider: providerId,
                  goose_model: modelId,
                  goose_thinking_effort: effort === 'off' ? 'none' : effort,
                });
            }}
          />
        ) : (
          <span className="text-xs text-text-secondary">
            {intl.formatMessage(
              thinkingError
                ? i18n.readError
                : providerId && modelId
                  ? i18n.loading
                  : followChatId
                    ? i18n.currentChat
                    : i18n.defaultModel
            )}
          </span>
        )}
      </div>
    </>
  );
}
