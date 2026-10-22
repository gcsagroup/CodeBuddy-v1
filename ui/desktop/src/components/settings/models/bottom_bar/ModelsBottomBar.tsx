import { useCallback, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bot, Check, LoaderCircle, Settings } from 'lucide-react';
import { DropdownChevron } from '../../../ui/DropdownChevron';
import { useLocation, useNavigate } from 'react-router-dom';
import { useModelAndProvider } from '../../../ModelAndProviderContext';
import { ModelThinkingMenu } from '../../../ThinkingEffortPicker';
import {
  acpReadModelDisplaySettings,
  acpListProviderDetails,
  type ModelDisplaySettings,
} from '../../../../acp/providers';
import {
  providerActivationDisabledReason,
  type ProviderDetails,
} from '../../../../types/providers';
import { defineMessages, useIntl } from '../../../../i18n';
import type { View } from '../../../../utils/navigationUtils';
import type { Message } from '../../../../types/message';
import type Model from '../modelInterface';
import { getModelDisplayName } from '../predefinedModelsUtils';
import { useIsMobile } from '../../../../hooks/use-mobile';
import { getModelDescription } from '../modelDescriptions';

const i18n = defineMessages({
  choose: { id: 'modelsBottomBar.selectOrChangeModel', defaultMessage: 'Select or change model' },
  loading: { id: 'modelsBottomBar.loadingModel', defaultMessage: 'Loading model...' },
  select: { id: 'modelsBottomBar.selectModel', defaultMessage: 'Select Model' },
  empty: { id: 'modelsBottomBar.empty', defaultMessage: 'No configured models' },
  failed: { id: 'modelsBottomBar.loadFailed', defaultMessage: 'Could not load models.' },
  retry: { id: 'modelsBottomBar.retry', defaultMessage: 'Retry' },
  manage: { id: 'modelsBottomBar.manage', defaultMessage: 'Manage model connections' },
  switching: { id: 'modelsBottomBar.switching', defaultMessage: 'Switching model…' },
  switchFailed: {
    id: 'modelsBottomBar.switchFailed',
    defaultMessage: 'Could not switch models. Try again.',
  },
});
type Selection = { provider: string; model: string; providerName: string };
const identity = (selection: { provider: string; model: string }) =>
  JSON.stringify([selection.provider, selection.model]);
interface ModelsBottomBarProps {
  sessionId: string | null;
  dropdownRef: React.RefObject<HTMLDivElement>;
  setView: (view: View) => void;
  sessionModel?: string | null;
  sessionProvider?: string | null;
  latestInference?: Message['metadata']['inference'] | null;
  onModelChanged: (override: { model: string; provider: string }) => void;
  sessionLoaded?: boolean;
}

export default function ModelsBottomBar({
  sessionId,
  dropdownRef,
  setView,
  sessionModel,
  sessionProvider,
  onModelChanged,
  sessionLoaded,
}: ModelsBottomBarProps) {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const narrowWindow = useIsMobile();
  const {
    currentModel: configModel,
    currentProvider: configProvider,
    changeModel,
  } = useModelAndProvider();
  const currentModel = sessionModel ?? configModel;
  const currentProvider = sessionProvider ?? configProvider;
  const loadingSession = Boolean(sessionId && !sessionLoaded);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<Selection | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const currentSession = useRef(sessionId);
  const listAnchor = useRef<HTMLDivElement>(null);
  const detailAnchor = useRef<HTMLButtonElement | null>(null);
  const detailCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const displayReads = useRef(
    new Map<
      string,
      {
        promise: Promise<ModelDisplaySettings>;
        value?: ModelDisplaySettings;
      }
    >()
  );
  const readDisplaySettings = useCallback((provider: string, model: string) => {
    const key = identity({ provider, model });
    const cached = displayReads.current.get(key);
    if (cached) return cached.promise;
    const entry: { promise: Promise<ModelDisplaySettings>; value?: ModelDisplaySettings } = {
      promise: acpReadModelDisplaySettings(provider, model),
    };
    displayReads.current.set(key, entry);
    void entry.promise.then(
      (value) => {
        entry.value = value;
        // Missing advisory metadata is not a durable model capability. Let the
        // next detail opening retry; keep complete reads and in-flight deduping.
        if (
          value.contextSource === 'fallback' &&
          !value.thinking.options.length &&
          displayReads.current.get(key) === entry
        )
          displayReads.current.delete(key);
      },
      () => {
        if (displayReads.current.get(key) === entry) displayReads.current.delete(key);
      }
    );
    return entry.promise;
  }, []);
  const retainDetail = () => clearTimeout(detailCloseTimer.current);
  const leaveDetail = () => {
    retainDetail();
    detailCloseTimer.current = setTimeout(() => setDetail(null), 150);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(detailCloseTimer.current);
    };
  }, []);
  currentSession.current = sessionId;
  useEffect(() => {
    let active = true;
    void acpListProviderDetails()
      .then(async (all) => {
        const queue = all
          .filter(
            (provider) => provider.is_configured && !providerActivationDisabledReason(provider)
          )
          .flatMap((provider) =>
            provider.metadata.known_models.map((model) => ({
              provider: provider.name,
              model: model.name,
            }))
          );
        let index = 0;
        await Promise.all(
          Array.from({ length: 3 }, async () => {
            while (active && index < queue.length) {
              const selection = queue[index++];
              try {
                await readDisplaySettings(selection.provider, selection.model);
              } catch {
                /* Preloading is optional; the hovered detail still reports its own read result. */
              }
            }
          })
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [readDisplaySettings]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setLoadError(false);
    setSwitchError('');
    void acpListProviderDetails()
      .then((all) => {
        if (!active) return;
        const configured = all.filter(
          (provider) => provider.is_configured && !providerActivationDisabledReason(provider)
        );
        setProviders(configured);
        setDetail(null);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, retry]);
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (!open) {
      clearTimeout(detailCloseTimer.current);
      setDetail(null);
    }
  }, [open]);
  const choose = async (selection: Selection) => {
    if (
      !mounted.current ||
      currentSession.current !== sessionId ||
      inFlight.current ||
      loadingSession
    )
      return;
    if (selection.provider === currentProvider && selection.model === currentModel) {
      return;
    }
    const requestedSession = sessionId;
    inFlight.current = true;
    setSwitching(identity(selection));
    setSwitchError('');
    try {
      let message = '';
      const model: Model = {
        name: selection.model,
        provider: selection.provider,
        subtext: selection.providerName,
      };
      const applied = await changeModel(requestedSession, model, {
        onError: (value) => {
          message = value;
        },
      });
      if (currentSession.current !== requestedSession) return;
      if (!applied) {
        setSwitchError(message || intl.formatMessage(i18n.switchFailed));
        return;
      }
      onModelChanged({ model: selection.model, provider: selection.provider });
    } catch {
      if (currentSession.current === requestedSession)
        setSwitchError(intl.formatMessage(i18n.switchFailed));
    } finally {
      inFlight.current = false;
      setSwitching(null);
    }
  };
  const manage = () => {
    setOpen(false);
    if (location.pathname.startsWith('/codepro'))
      navigate('/codepro/settings', { state: { section: 'models' } });
    else setView('configureProviders');
  };
  return (
    <div className="relative flex min-w-0 max-w-full items-center" ref={dropdownRef}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={intl.formatMessage(i18n.choose)}
            title={intl.formatMessage(i18n.choose)}
            disabled={loadingSession}
            className="flex min-w-0 max-w-full items-center gap-1 text-xs text-text-primary/70 hover:text-text-primary disabled:opacity-60"
          >
            {loadingSession ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <Bot className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate group-data-[compact=true]/composer-toolbar:hidden">
              {loadingSession
                ? intl.formatMessage(i18n.loading)
                : currentModel
                  ? getModelDisplayName(currentModel)
                  : intl.formatMessage(i18n.select)}
            </span>
            <DropdownChevron
              open={open}
              className="size-3 shrink-0 group-data-[compact=true]/composer-toolbar:hidden"
            />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            ref={listAnchor}
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            data-model-picker-list
            onInteractOutside={(event) => {
              if (
                event.target instanceof window.Element &&
                event.target.closest('[data-model-picker-details], [data-thinking-effort-card]')
              )
                event.preventDefault();
            }}
            className="z-[100] flex max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border-primary bg-background-primary p-1.5 text-text-primary shadow-md"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div
                role="group"
                aria-label={intl.formatMessage(i18n.choose)}
                aria-busy={loading || !!switching}
                className="min-h-0 max-h-[min(26rem,55vh)] overflow-y-auto overscroll-contain"
              >
                {loading ? (
                  <p role="status" className="px-3 py-4 text-sm text-text-secondary">
                    {intl.formatMessage(i18n.loading)}
                  </p>
                ) : loadError ? (
                  <div role="alert" className="px-3 py-3 text-sm text-text-secondary">
                    <p>{intl.formatMessage(i18n.failed)}</p>
                    <button
                      type="button"
                      className="mt-2 underline"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      {intl.formatMessage(i18n.retry)}
                    </button>
                  </div>
                ) : providers.length ? (
                  providers.map((provider) => (
                    <div key={provider.name} className="space-y-1">
                      <p className="px-3 pb-1 pt-2 text-xs text-text-secondary">
                        {provider.metadata.display_name}
                      </p>
                      {provider.metadata.known_models.map((model) => {
                        const selection = {
                          provider: provider.name,
                          providerName: provider.metadata.display_name,
                          model: model.name,
                        };
                        const selected =
                          provider.name === currentProvider && model.name === currentModel;
                        return (
                          <button
                            key={model.name}
                            type="button"
                            disabled={!!switching}
                            aria-pressed={selected}
                            title={model.name}
                            // Popup positioning can generate mouseenter beneath a stationary pointer.
                            onMouseMove={(event) => {
                              retainDetail();
                              detailAnchor.current = event.currentTarget;
                              setDetail((previous) =>
                                previous && identity(previous) === identity(selection)
                                  ? previous
                                  : selection
                              );
                            }}
                            onMouseLeave={leaveDetail}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowRight') {
                                event.preventDefault();
                                retainDetail();
                                detailAnchor.current = event.currentTarget;
                                setDetail(selection);
                              }
                            }}
                            onClick={() => void choose(selection)}
                            className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-background-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 ${selected || (detail && identity(detail) === identity(selection)) ? 'bg-background-secondary' : ''}`}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {getModelDisplayName(model.name)}
                            </span>
                            {switching === identity(selection) ? (
                              <LoaderCircle
                                aria-label={intl.formatMessage(i18n.switching)}
                                className="size-3.5 shrink-0 animate-spin"
                              />
                            ) : (
                              selected && (
                                <Check
                                  className="size-3.5 shrink-0 text-text-secondary"
                                  aria-hidden="true"
                                />
                              )
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))
                ) : (
                  <p className="px-3 py-4 text-sm text-text-secondary">
                    {intl.formatMessage(i18n.empty)}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={!!switching}
                onClick={manage}
                className="mt-1 flex min-h-9 w-full shrink-0 items-center gap-2 border-t border-border-secondary px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-secondary"
              >
                <Settings className="size-3.5 shrink-0" aria-hidden="true" />
                {intl.formatMessage(i18n.manage)}
              </button>
            </div>
            {detail && (
              <Popover.Root
                open={open}
                onOpenChange={(next) => {
                  if (!next) setDetail(null);
                }}
              >
                <Popover.Anchor
                  virtualRef={{
                    current: (narrowWindow ? listAnchor.current : detailAnchor.current)!,
                  }}
                />
                <Popover.Portal>
                  <Popover.Content
                    data-model-picker-details
                    onMouseEnter={retainDetail}
                    onMouseLeave={leaveDetail}
                    side={narrowWindow ? 'top' : 'right'}
                    align={narrowWindow ? 'start' : 'end'}
                    sideOffset={8}
                    collisionPadding={12}
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    onInteractOutside={(event) => {
                      if (
                        event.target instanceof window.Element &&
                        event.target.closest(
                          '[data-model-picker-list], [data-thinking-effort-card]'
                        )
                      )
                        event.preventDefault();
                    }}
                    className="z-[105] max-h-[var(--radix-popover-content-available-height)] w-[min(19rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border-primary bg-background-primary p-4 text-text-primary shadow-md"
                  >
                    <p className="break-words text-base font-semibold">
                      {getModelDisplayName(detail.model)}
                    </p>
                    <p className="mt-1 break-words text-xs text-text-secondary">
                      {getModelDescription(intl, detail.model, detail.providerName)}
                    </p>
                    <div className="mt-4 border-t border-border-secondary pt-3">
                      <ModelThinkingMenu
                        key={identity(detail)}
                        provider={detail.provider}
                        model={detail.model}
                        popupSide={narrowWindow ? 'top' : 'left'}
                        showContextWindow
                        initialSettings={displayReads.current.get(identity(detail))?.value}
                        readSettings={readDisplaySettings}
                        onEffortChanged={(settings) => {
                          displayReads.current.set(identity(detail), {
                            promise: Promise.resolve(settings),
                            value: settings,
                          });
                          return choose(detail);
                        }}
                        onSavingChange={(saving) => {
                          if (mounted.current) setSwitching(saving ? identity(detail) : null);
                        }}
                        showLabel
                      />
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
            {switchError && (
              <p role="alert" className="px-3 pt-2 text-xs text-text-danger">
                {switchError}
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
