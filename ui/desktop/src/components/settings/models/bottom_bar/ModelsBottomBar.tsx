import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { DropdownChevron } from '../../../ui/DropdownChevron';
import { useLocation, useNavigate } from 'react-router-dom';
import { useModelAndProvider } from '../../../ModelAndProviderContext';
import { ModelThinkingMenu } from '../../../ThinkingEffortPicker';
import { acpListProviderDetails, acpRefreshProviderModels } from '../../../../acp/providers';
import { acpErrorData } from '../../../../acp/errors';
import { NetworkAccessCancelled } from '../../../../utils/networkAccess';
import { connectionMessages } from '../../providers/connectionMessages';
import {
  providerActivationDisabledReason,
  type ProviderDetails,
} from '../../../../types/providers';
import { defineMessages, useIntl } from '../../../../i18n';
import type { View } from '../../../../utils/navigationUtils';
import type { Message } from '../../../../types/message';
import type Model from '../modelInterface';
import { getModelDisplayName } from '../predefinedModelsUtils';

const i18n = defineMessages({
  choose: { id: 'modelsBottomBar.selectOrChangeModel', defaultMessage: 'Select or change model' },
  loading: { id: 'modelsBottomBar.loadingModel', defaultMessage: 'Loading model...' },
  select: { id: 'modelsBottomBar.selectModel', defaultMessage: 'Select Model' },
  empty: { id: 'modelsBottomBar.empty', defaultMessage: 'No configured models' },
  failed: { id: 'modelsBottomBar.loadFailed', defaultMessage: 'Could not load models.' },
  retry: { id: 'modelsBottomBar.retry', defaultMessage: 'Retry' },
  refresh: { id: 'modelsBottomBar.refresh', defaultMessage: 'Refresh models' },
  refreshing: { id: 'modelsBottomBar.refreshing', defaultMessage: 'Refreshing models…' },
  refreshed: { id: 'modelsBottomBar.refreshed', defaultMessage: 'Model list updated.' },
  refreshFailed: {
    id: 'modelsBottomBar.refreshFailed',
    defaultMessage:
      'Could not update model lists for {failed} of {total} connections.',
  },
  cachedList: { id: 'modelsBottomBar.cachedList', defaultMessage: 'Showing the last saved list.' },
  noSavedList: { id: 'modelsBottomBar.noSavedList', defaultMessage: 'No saved model list.' },
  inventoryReadFailed: { id: 'modelsBottomBar.inventoryReadFailed', defaultMessage: 'Could not read the updated lists. The menu still shows the lists from before the refresh.' },
  unknownReason: { id: 'modelsBottomBar.unknownReason', defaultMessage: 'No specific reason was reported.' },
  manage: { id: 'modelsBottomBar.manage', defaultMessage: 'Manage model connections' },
  switching: { id: 'modelsBottomBar.switching', defaultMessage: 'Switching model…' },
  switchFailed: {
    id: 'modelsBottomBar.switchFailed',
    defaultMessage: 'Could not switch models. Try again.',
  },
  switchFailedLabel: {
    id: 'modelsBottomBar.switchFailedLabel',
    defaultMessage: 'Switch failed',
  },
  search: { id: 'modelsBottomBar.search', defaultMessage: 'Search models or connections' },
  noMatches: { id: 'modelsBottomBar.noMatches', defaultMessage: 'No matching models' },
  showMore: { id: 'modelsBottomBar.showMore', defaultMessage: 'Show {count} more' },
  showFewer: { id: 'modelsBottomBar.showFewer', defaultMessage: 'Show fewer' },
});

const MODEL_PREVIEW_COUNT = 6;
function refreshFailureReason(error: unknown, intl: ReturnType<typeof useIntl>) {
  if (error instanceof NetworkAccessCancelled) return error.message;
  const data = acpErrorData(error);
  const status = data?.httpStatus;
  const http = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
  const reasons: Record<string, { id: string; defaultMessage: string }> = {
    custom_provider_invalid_credentials: connectionMessages.invalidCredentials,
    custom_provider_api_key_required: connectionMessages.apiKeyRequiredForConnection,
    custom_provider_endpoint_unreachable: connectionMessages.endpointUnreachable,
    custom_provider_permission_denied: connectionMessages.permissionDenied,
    custom_provider_no_models: connectionMessages.noModels,
    custom_provider_model_list_unavailable: connectionMessages.modelListUnavailable,
    custom_provider_invalid_response: connectionMessages.invalidResponse,
    custom_provider_response_too_large: connectionMessages.responseTooLarge,
  };
  let reason = typeof data?.code === 'string' && Object.prototype.hasOwnProperty.call(reasons, data.code)
    ? reasons[data.code] : undefined;
  if (http === 401) reason = connectionMessages.invalidCredentials;
  if (http === 403) reason = connectionMessages.permissionDenied;
  if (http === 429) reason = connectionMessages.rateLimited;
  if (http && http >= 500) reason = connectionMessages.serviceUnavailable;
  return [http && `HTTP ${http}`, intl.formatMessage(reason ?? i18n.unknownReason)].filter(Boolean).join(' · ');
}
type RefreshResult = {
  total: number;
  failures: { id: string; name: string; reason: string }[];
  inventoryReadFailed: boolean;
};
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
  openRequest?: number;
}

export default function ModelsBottomBar({
  sessionId,
  dropdownRef,
  setView,
  sessionModel,
  sessionProvider,
  onModelChanged,
  sessionLoaded,
  openRequest = 0,
}: ModelsBottomBarProps) {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    currentModel: configModel,
    currentProvider: configProvider,
    changeModel,
  } = useModelAndProvider();
  const currentModel = sessionModel ?? configModel;
  const currentProvider = sessionProvider ?? configProvider;
  const loadingSession = Boolean(sessionId && !sessionLoaded);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);
  const refreshInFlight = useRef(false);
  const loadVersion = useRef(0);
  const [switchError, setSwitchError] = useState<{
    message: string;
    selection: Selection;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const refresh = () => setRetry(value => value + 1);
    window.addEventListener('codebuddy:model-inventory-updated', refresh);
    return () => window.removeEventListener('codebuddy:model-inventory-updated', refresh);
  }, []);
  const [modelQuery, setModelQuery] = useState('');
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [expandedModelLists, setExpandedModelLists] = useState<Record<string, boolean>>({});
  const [switching, setSwitching] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const currentSession = useRef(sessionId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  currentSession.current = sessionId;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const versions = loadVersion;
    const version = ++versions.current;
    setLoading(true);
    setLoadError(false);
    setRefreshResult(null);
    void acpListProviderDetails()
      .then((all) => {
        if (!active || version !== versions.current) return;
        const configured = all.filter(
          (provider) => provider.is_configured && !providerActivationDisabledReason(provider)
        );
        setProviders(configured);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      ++versions.current;
    };
  }, [open, retry]);
  const refreshModels = async () => {
    if (refreshInFlight.current || loading || switching || !providers.length) return;
    refreshInFlight.current = true;
    const version = ++loadVersion.current;
    setRefreshing(true);
    setRefreshResult(null);
    const result: RefreshResult = { total: providers.length, failures: [], inventoryReadFailed: false };
    try {
      const results = await Promise.allSettled(
        providers.map((provider) => acpRefreshProviderModels(provider.name))
      );
      results.forEach((outcome, i) => {
        if (outcome.status !== 'rejected') return;
        const provider = providers[i];
        result.failures.push({
          id: provider.name, name: provider.metadata.display_name || provider.name,
          reason: refreshFailureReason(outcome.reason, intl),
        });
      });
      const all = await acpListProviderDetails();
      if (!mounted.current || version !== loadVersion.current) return;
      setProviders(
        all.filter(
          (provider) => provider.is_configured && !providerActivationDisabledReason(provider)
        )
      );
    } catch {
      result.inventoryReadFailed = true;
    } finally {
      if (mounted.current && version === loadVersion.current) setRefreshResult(result);
      refreshInFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  };
  useEffect(() => {
    setOpen(false);
    setSwitchError(null);
  }, [sessionId]);
  useEffect(() => {
    if (!open) {
      setModelQuery('');
      setExpandedProviders({});
      setExpandedModelLists({});
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
    if (
      selection.provider === currentProvider &&
      selection.model === currentModel &&
      selection.provider === configProvider &&
      selection.model === configModel
    ) {
      return;
    }
    const requestedSession = sessionId;
    inFlight.current = true;
    setSwitching(identity(selection));
    setSwitchError(null);
    try {
      let message = '';
      const model: Model = {
        name: selection.model,
        provider: selection.provider,
        subtext: selection.providerName,
      };
      const applied = await changeModel(requestedSession, model, {
        updateDefaults: true,
        onError: (value) => {
          message = value;
        },
      });
      if (!mounted.current || currentSession.current !== requestedSession) return;
      if (!applied) {
        setSwitchError({ message: message || intl.formatMessage(i18n.switchFailed), selection });
        return;
      }
      onModelChanged({ model: selection.model, provider: selection.provider });
    } catch {
      if (mounted.current && currentSession.current === requestedSession)
        setSwitchError({ message: intl.formatMessage(i18n.switchFailed), selection });
    } finally {
      inFlight.current = false;
      if (mounted.current) setSwitching(null);
    }
  };
  const manage = () => {
    setOpen(false);
    if (location.pathname.startsWith('/codepro'))
      navigate('/codepro/settings', { state: { section: 'models' } });
    else setView('configureProviders');
  };
  const query = modelQuery.trim().toLocaleLowerCase();
  const visibleProviders = [...providers]
    .sort((a, b) => Number(b.name === currentProvider) - Number(a.name === currentProvider))
    .map((provider) => {
      const connectionMatches = [provider.name, provider.metadata.display_name].some((name) =>
        name.toLocaleLowerCase().includes(query)
      );
      const models = [...provider.metadata.known_models]
        .filter(
          (model) => !query || connectionMatches || model.name.toLocaleLowerCase().includes(query)
        )
        .sort((a, b) =>
          provider.name === currentProvider
            ? Number(b.name === currentModel) - Number(a.name === currentModel)
            : 0
        );
      return { provider, models };
    })
    .filter(({ models }) => models.length > 0);
  return (
    <div className="relative flex min-w-0 max-w-full items-center" ref={dropdownRef}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        {!loadingSession && currentProvider && currentModel ? (
          <Popover.Anchor asChild>
            <div className="min-w-0 max-w-full">
              <ModelThinkingMenu
                deferUntilSubmit
                key={identity({ provider: currentProvider, model: currentModel })}
                provider={currentProvider}
                model={currentModel}
                presentation="slider"
                modelLabel={getModelDisplayName(currentModel)}
                onSelectModel={() => setOpen(true)}
                modelMenuOpen={open}
                disabled={!!switching}
                triggerContent={
                  <>
                    {switching ? (
                      <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                    ) : (
                      <Bot className="size-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 max-w-44 truncate @max-[20rem]/composer:hidden">
                      {getModelDisplayName(currentModel)}
                    </span>
                  </>
                }
              />
            </div>
          </Popover.Anchor>
        ) : (
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={intl.formatMessage(i18n.choose)}
              title={intl.formatMessage(i18n.choose)}
              disabled={loadingSession}
              aria-busy={!!switching}
              className="flex min-w-0 max-w-full items-center gap-1 text-xs text-text-primary/70 hover:text-text-primary disabled:opacity-60"
            >
              {loadingSession || switching ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <Bot className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 max-w-44 truncate @max-[20rem]/composer:hidden">
                {loadingSession
                  ? intl.formatMessage(i18n.loading)
                  : currentModel
                    ? getModelDisplayName(currentModel)
                    : intl.formatMessage(i18n.select)}
              </span>
              <DropdownChevron open={open} className="size-3 shrink-0" />
            </button>
          </Popover.Trigger>
        )}
        <Popover.Portal>
          <Popover.Content
            updatePositionStrategy="always"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            data-model-picker-list
            className="composer-menu-surface z-[100] flex max-h-[var(--radix-popover-content-available-height)] w-[min(17.6rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border border-border-primary p-[5px] text-text-primary shadow-md"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-1">
                <input
                  type="search"
                  value={modelQuery}
                  aria-label={intl.formatMessage(i18n.search)}
                  placeholder={intl.formatMessage(i18n.search)}
                  onChange={(event) => {
                    setModelQuery(event.target.value);
                  }}
                  className="m-0.5 min-w-0 flex-1 rounded-md border border-border-secondary bg-transparent px-2.5 py-1.5 text-[11px] leading-4 outline-none focus:border-border-primary"
                />
                <button
                  type="button"
                  aria-label={intl.formatMessage(i18n.refresh)}
                  title={intl.formatMessage(i18n.refresh)}
                  aria-busy={refreshing}
                  disabled={loading || refreshing || !!switching || !providers.length}
                  onClick={() => void refreshModels()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-background-secondary disabled:opacity-50"
                >
                  <RefreshCw
                    className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              </div>
              {refreshResult && (refreshResult.failures.length > 0 || refreshResult.inventoryReadFailed) ? (
                <div role="alert" className="mx-1 my-1 max-h-[24vh] overflow-y-auto rounded-md bg-background-secondary px-2.5 py-2 text-xs leading-5">
                  {refreshResult.failures.length > 0 && <>
                    <p className="font-medium">{intl.formatMessage(i18n.refreshFailed, {
                      failed: refreshResult.failures.length, total: refreshResult.total,
                    })}</p>
                    <ul className="space-y-1">
                      {refreshResult.failures.map(failure => (
                        <li key={failure.id} className="break-words">
                          <strong>{failure.name}</strong> · {failure.reason}{' '}
                          {intl.formatMessage(providers.some(p => p.name === failure.id && p.metadata.known_models.length)
                            ? i18n.cachedList : i18n.noSavedList)}
                        </li>
                      ))}
                    </ul>
                  </>}
                  {refreshResult.inventoryReadFailed && <p>{intl.formatMessage(i18n.inventoryReadFailed)}</p>}
                  <button type="button" className="font-medium underline" disabled={refreshing || loading || !!switching}
                    onClick={() => void refreshModels()}>{intl.formatMessage(i18n.retry)}</button>
                </div>
              ) : (refreshing || refreshResult) && (
                <p role="status" className="px-2.5 py-1 text-[11px] leading-4 text-text-secondary">
                  {intl.formatMessage(refreshing ? i18n.refreshing : i18n.refreshed)}
                </p>
              )}
              <div
                role="group"
                aria-label={intl.formatMessage(i18n.choose)}
                aria-busy={loading || refreshing || !!switching}
                className="min-h-0 max-h-[min(20.8rem,44vh)] overflow-y-auto overscroll-contain"
              >
                {loading ? (
                  <p
                    role="status"
                    className="px-2.5 py-1.5 text-[11px] leading-4 text-text-secondary"
                  >
                    {intl.formatMessage(i18n.loading)}
                  </p>
                ) : loadError ? (
                  <div
                    role="alert"
                    className="px-2.5 py-1.5 text-[11px] leading-4 text-text-secondary"
                  >
                    <p>{intl.formatMessage(i18n.failed)}</p>
                    <button
                      type="button"
                      className="mt-2 underline"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      {intl.formatMessage(i18n.retry)}
                    </button>
                  </div>
                ) : visibleProviders.length ? (
                  visibleProviders.map(({ provider, models }) => {
                    const expanded =
                      !!query ||
                      (expandedProviders[provider.name] ??
                        provider.name === (currentProvider ?? providers[0]?.name));
                    const showAll = !!query || expandedModelLists[provider.name];
                    const previewCount = MODEL_PREVIEW_COUNT;
                    const shownModels = showAll ? models : models.slice(0, previewCount);
                    return (
                      <div key={provider.name} className="space-y-0.5">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${provider.metadata.display_name} (${intl.formatNumber(models.length)})`}
                          disabled={!!query}
                          onClick={() => {
                            setExpandedProviders((previous) => ({
                              ...previous,
                              [provider.name]: !expanded,
                            }));
                          }}
                          className="flex min-h-[29px] w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[10px] leading-[13px] text-text-secondary hover:bg-background-secondary"
                        >
                          {expanded ? (
                            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {provider.metadata.display_name}
                          </span>
                          <span>({intl.formatNumber(models.length)})</span>
                        </button>
                        {expanded &&
                          shownModels.map((model) => {
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
                                onClick={() => void choose(selection)}
                                className={`flex min-h-[29px] w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[11px] leading-4 hover:bg-background-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 ${selected ? 'bg-background-secondary' : ''}`}
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {getModelDisplayName(model.name)}
                                </span>
                                {switching === identity(selection) ? (
                                  <LoaderCircle
                                    aria-label={intl.formatMessage(i18n.switching)}
                                    className="size-3 shrink-0 animate-spin"
                                  />
                                ) : (
                                  selected && (
                                    <Check
                                      className="size-3 shrink-0 text-text-secondary"
                                      aria-hidden="true"
                                    />
                                  )
                                )}
                              </button>
                            );
                          })}
                        {expanded && !query && models.length > previewCount && (
                          <button
                            type="button"
                            aria-expanded={!!showAll}
                            onClick={() => {
                              setExpandedModelLists((previous) => ({
                                ...previous,
                                [provider.name]: !showAll,
                              }));
                            }}
                            className="flex min-h-[29px] w-full items-center rounded-md px-2.5 py-1.5 text-left text-[10px] leading-[13px] text-text-secondary hover:bg-background-secondary"
                          >
                            {intl.formatMessage(showAll ? i18n.showFewer : i18n.showMore, {
                              count: models.length - previewCount,
                            })}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <p className="px-2.5 py-1.5 text-[11px] leading-4 text-text-secondary">
                    {intl.formatMessage(query ? i18n.noMatches : i18n.empty)}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={!!switching}
                onClick={manage}
                className="mt-0.5 flex min-h-[29px] w-full shrink-0 items-center gap-1.5 border-t border-border-secondary px-2.5 py-1.5 text-left text-[11px] leading-4 text-text-secondary hover:bg-background-secondary"
              >
                <Settings className="size-3 shrink-0" aria-hidden="true" />
                {intl.formatMessage(i18n.manage)}
              </button>
            </div>
            {switchError && (
              <div className="flex items-start gap-1.5 px-2.5 pb-1 pt-2 text-[10px] leading-[13px] text-text-secondary">
                <p role="alert" className="min-w-0 flex-1 break-words">
                  {switchError.message}
                </p>
                <button
                  type="button"
                  disabled={!!switching}
                  onClick={() => void choose(switchError.selection)}
                  className="shrink-0 underline underline-offset-2 disabled:opacity-60"
                >
                  {intl.formatMessage(i18n.retry)}
                </button>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {!open && switchError && (
        <span role="alert" className="ml-2 flex min-w-0 items-center text-xs text-text-secondary">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={switchError.message}
            className="flex min-w-0 items-center gap-1 underline underline-offset-2"
          >
            {intl.formatMessage(i18n.switchFailedLabel)}
          </button>
        </span>
      )}
    </div>
  );
}
