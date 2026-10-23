import { useEffect, useMemo, useRef, useState } from 'react';
import distributionModel from '../../../../../runtime/default-model.json';
import { AlertTriangle, Bot } from 'lucide-react';
import {
  readCodeProModelRouting,
  saveCodeProModelRouting,
  DISABLED_CODEPRO_MODEL_ROUTING,
  type CodeProVisionRoute,
  type CodeProModelRoutingConfig,
  type CodeProModelRoutingRole,
} from '../../acp/codeproModelRouting';
import {
  acpListProviderDetails,
  acpListProviderModels,
  acpReadDefaults,
} from '../../acp/providers';
import { defineMessages, useIntl } from '../../i18n';
import { providerActivationDisabledReason, type ProviderDetails } from '../../types/providers';
import type { ProviderInventoryModelDto } from '@aaif/goose-sdk';
import { resolveModelCapability, type ModelCapabilityState } from '../../acp/modelCapabilities';
import { acpErrorData, errorMessage } from '../../utils/conversionUtils';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

type CodeProAgentRole = CodeProModelRoutingRole;
type ProviderDiscoveryState = 'loading' | 'ready' | 'unavailable' | 'retrying';

interface AgentModelSelection {
  model: string;
  provider: string;
}

interface AgentRoleDefinition {
  description: string;
  label: string;
  role: CodeProAgentRole;
}

const i18n = defineMessages({
  title: { id: 'codeProModels.title', defaultMessage: 'Agent model configuration' },
  description: {
    id: 'codeProModels.description',
    defaultMessage:
      'Use the current default model for every agent, or enable advanced routing to choose configured provider models by role. Changes take effect on the next task.',
  },
  main: { id: 'codeProModels.main', defaultMessage: 'Main agent' },
  mainDescription: {
    id: 'codeProModels.mainDescription',
    defaultMessage: 'Communicates with you, carries out tasks, and coordinates delegated work',
  },
  planner: { id: 'codeProModels.planner', defaultMessage: 'Analysis agent' },
  plannerDescription: {
    id: 'codeProModels.plannerDescription',
    defaultMessage: 'Understands requirements, breaks down tasks, and arranges dependencies',
  },
  coder: { id: 'codeProModels.coder', defaultMessage: 'Coding agent' },
  coderDescription: {
    id: 'codeProModels.coderDescription',
    defaultMessage: 'Implements code and reports changes',
  },
  tester: { id: 'codeProModels.tester', defaultMessage: 'Testing agent' },
  testerDescription: {
    id: 'codeProModels.testerDescription',
    defaultMessage: 'Adds tests, runs verification, and records evidence',
  },
  reviewer: { id: 'codeProModels.reviewer', defaultMessage: 'Review agent' },
  reviewerDescription: {
    id: 'codeProModels.reviewerDescription',
    defaultMessage: 'Independently reviews patches, tests, and security boundaries',
  },
  followsCurrentModel: {
    id: 'codeProModels.followsCurrentModel',
    defaultMessage: 'Follows current model: {provider} / {model}',
  },
  actualModel: {
    id: 'codeProModels.actualModel',
    defaultMessage: 'Actual model: {provider} / {model} · Separate setting',
  },
  legacyDefaultHintCatalogEntry: {
    id: 'codeProModels.defaultHint',
    defaultMessage: 'Default',
  },
  systemDefault: { id: 'codeProModels.systemDefault', defaultMessage: 'System default' },
  selectModel: { id: 'codeProModels.selectModel', defaultMessage: 'Select a model' },
  providerLabel: {
    id: 'codeProModels.providerLabel',
    defaultMessage: '{role} provider',
  },
  modelLabel: {
    id: 'codeProModels.modelLabel',
    defaultMessage: '{role} model',
  },
  advancedRouting: {
    id: 'codeProModels.advancedRouting',
    defaultMessage: 'Enable advanced model routing',
  },
  disabledRoutingHint: {
    id: 'codeProModels.disabledRoutingHint',
    defaultMessage:
      'All agents follow the current model. Your model combination is kept for when you enable this again.',
  },
  legacyAdvancedRoutingHintCatalogEntry: {
    id: 'codeProModels.advancedRoutingHint',
    defaultMessage:
      'Off uses the default Ollama Cloud / glm-5.2 route for every role and runs one agent at a time. Enable only to configure overrides that you have validated.',
  },
  cancel: { id: 'codeProModels.cancel', defaultMessage: 'Cancel' },
  save: { id: 'codeProModels.save', defaultMessage: 'Save combination' },
  saveVision: { id: 'codeProModels.saveVision', defaultMessage: 'Save vision settings' },
  saveAnyway: { id: 'codeProModels.saveAnyway', defaultMessage: 'Save anyway' },
  saving: { id: 'codeProModels.saving', defaultMessage: 'Saving…' },
  duplicateWarning: {
    id: 'codeProModels.duplicateWarning',
    defaultMessage:
      '{groups}. Using the same model for different agents may reproduce the same blind spots and reduce independent review and bug detection. Change the combination, or save anyway if this is intentional.',
  },
  duplicateGroup: {
    id: 'codeProModels.duplicateGroup',
    defaultMessage: '{roles} use the same model {model}',
  },
  loadError: {
    id: 'codeProModels.loadError',
    defaultMessage: 'Failed to load models. Check the provider configuration.',
  },
  providerLoading: {
    id: 'codeProModels.providerLoading',
    defaultMessage: 'Loading models…',
  },
  providerReady: {
    id: 'codeProModels.providerReady',
    defaultMessage: 'Available',
  },
  providerUnavailable: {
    id: 'codeProModels.providerUnavailable',
    defaultMessage: 'Temporarily unavailable',
  },
  providerRetrying: {
    id: 'codeProModels.providerRetrying',
    defaultMessage: 'Retrying…',
  },
  retry: { id: 'appsView.retry', defaultMessage: 'Retry' },
  saveError: {
    id: 'codeProModels.saveError',
    defaultMessage: 'Failed to save. Try again later.',
  },
  missingSelection: {
    id: 'codeProModels.missingSelection',
    defaultMessage: 'Choose both a provider and model for {role}.',
  },
  providerRemoved: {
    id: 'codeProModels.providerRemoved',
    defaultMessage:
      '{role} uses {provider}, which is no longer configured. Choose another provider.',
  },
  providerModelsLoading: {
    id: 'codeProModels.providerModelsLoading',
    defaultMessage: 'Models for {provider} are still loading. Wait a moment, then save again.',
  },
  providerModelsUnavailable: {
    id: 'codeProModels.providerModelsUnavailable',
    defaultMessage:
      '{role} cannot use {provider} because its models could not be loaded. Test that connection again or choose another provider.',
  },
  modelUnavailable: {
    id: 'codeProModels.modelUnavailable',
    defaultMessage:
      '{role} uses {model}, which is no longer available from {provider}. Choose another model.',
  },
  unavailableProviderOption: {
    id: 'codeProModels.unavailableProviderOption',
    defaultMessage: '{provider} (Temporarily unavailable)',
  },
  useAnotherProvider: {
    id: 'codeProModels.useAnotherProvider',
    defaultMessage: 'Use another provider…',
  },
  visionAgent: {
    id: 'codeProModels.visionAgent',
    defaultMessage: 'Backup image model',
  },
  customVision: {
    id: 'codeProModels.customVision',
    defaultMessage: 'Use a custom image model',
  },
  visionDefault: {
    id: 'codeProModels.visionDefault',
    defaultMessage: 'Default: {model}',
  },
  visionDefaultUnavailable: {
    id: 'codeProModels.visionDefaultUnavailable',
    defaultMessage: 'The default Flash model is not configured. Choose a custom image model.',
  },
  visionAgentDescription: {
    id: 'codeProModels.visionAgentDescription',
    defaultMessage:
      'The current model reads images when supported. Otherwise images and your question go to the selected auxiliary model, which may add time and cost.',
  },
  visionModelLabel: {
    id: 'codeProModels.visionModelLabel',
    defaultMessage: 'Image model',
  },
  visionDefaultProvider: {
    id: 'codeProModels.visionDefaultProvider',
    defaultMessage: 'Not configured (disabled)',
  },
  visionDefaultModel: {
    id: 'codeProModels.visionDefaultModel',
    defaultMessage: 'Select model',
  },
  visionChecking: { id: 'codeProModels.visionChecking', defaultMessage: 'Checking image support…' },
  visionSupportedOnly: {
    id: 'codeProModels.visionSupportedOnly',
    defaultMessage: 'Only models with confirmed image input are listed.',
  },
  visionNoModels: {
    id: 'codeProModels.visionNoModels',
    defaultMessage: 'No models with confirmed image input are available on this connection.',
  },
  visionCapabilityError: {
    id: 'codeProModels.visionCapabilityError',
    defaultMessage: 'Could not verify image support. Retry before saving.',
  },
  visionUnsupported: {
    id: 'codeProModels.visionUnsupported',
    defaultMessage: 'Select a backup model with confirmed image support.',
  },
  visionUnavailableSelection: {
    id: 'codeProModels.visionUnavailableSelection',
    defaultMessage: 'Image support not confirmed: {model}',
  },
  visionUnsupportedSelection: {
    id: 'codeProModels.visionUnsupportedSelection',
    defaultMessage: 'Image input not supported: {model}',
  },
});

const emptySelection = (): AgentModelSelection => ({ model: '', provider: '' });
const selectionsFromDefault = (
  selection: AgentModelSelection
): Record<CodeProAgentRole, AgentModelSelection> => ({
  main: { ...selection },
  planner: { ...selection },
  coder: { ...selection },
  tester: { ...selection },
  reviewer: { ...selection },
});

const CONFIGURE_PROVIDER_VALUE = '__configure_provider__';
const DEFAULT_IMAGE_MODEL = distributionModel.modelId;

export function CodeProModelModal({
  onClose,
  onConfigureProvider,
  currentDefault,
  visionOnly = false,
}: {
  onClose: () => void;
  onConfigureProvider?: () => void;
  currentDefault?: AgentModelSelection;
  visionOnly?: boolean;
}) {
  const intl = useIntl();
  const [defaultSelection, setDefaultSelection] = useState<AgentModelSelection>(emptySelection());
  const roles = useMemo<AgentRoleDefinition[]>(
    () => [
      {
        role: 'main',
        label: intl.formatMessage(i18n.main),
        description: intl.formatMessage(i18n.mainDescription),
      },
      {
        role: 'planner',
        label: intl.formatMessage(i18n.planner),
        description: intl.formatMessage(i18n.plannerDescription),
      },
      {
        role: 'coder',
        label: intl.formatMessage(i18n.coder),
        description: intl.formatMessage(i18n.coderDescription),
      },
      {
        role: 'tester',
        label: intl.formatMessage(i18n.tester),
        description: intl.formatMessage(i18n.testerDescription),
      },
      {
        role: 'reviewer',
        label: intl.formatMessage(i18n.reviewer),
        description: intl.formatMessage(i18n.reviewerDescription),
      },
    ],
    [intl]
  );
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [activationDisabledProviderIds, setActivationDisabledProviderIds] = useState<Set<string>>(
    new Set()
  );
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, ProviderInventoryModelDto[]>
  >({});
  const [selections, setSelections] = useState<Record<CodeProAgentRole, AgentModelSelection>>({
    main: emptySelection(),
    planner: emptySelection(),
    coder: emptySelection(),
    tester: emptySelection(),
    reviewer: emptySelection(),
  });
  const [advancedRoutingEnabled, setAdvancedRoutingEnabled] = useState(false);
  const [visionRoute, setVisionRoute] = useState<CodeProVisionRoute>({
    enabled: false,
    mode: 'disabled',
  });
  const [configurationLoaded, setConfigurationLoaded] = useState(false);
  const [operationError, setOperationError] = useState('');
  const [discoveryError, setDiscoveryError] = useState('');
  const [modelDiscoveryComplete, setModelDiscoveryComplete] = useState(false);
  const [providerDiscoveryState, setProviderDiscoveryState] = useState<
    Record<string, ProviderDiscoveryState>
  >({});
  const [modelLoadAttempt, setModelLoadAttempt] = useState(0);
  const [customVisionDraft, setCustomVisionDraft] = useState<boolean>();
  const modelRequestGeneration = useRef(0);
  const visionInventory = useMemo(
    () =>
      providers.flatMap((provider) =>
        (modelsByProvider[provider.name] ?? []).map((model) => ({
          ...model,
          providerId: provider.name,
          providerLabel: provider.metadata.display_name || provider.name,
          key: JSON.stringify([provider.name, model.id]),
        }))
      ),
    [providers, modelsByProvider]
  );
  const defaultVisionModel = useMemo(() => {
    const candidates = visionInventory.filter((model) => model.id === DEFAULT_IMAGE_MODEL);
    return (
      candidates.find((model) => model.providerId === distributionModel.providerId) ??
      candidates.find((model) => model.providerId === defaultSelection.provider) ??
      (candidates.length === 1 ? candidates[0] : undefined)
    );
  }, [visionInventory, defaultSelection.provider]);
  const selectedVisionKey =
    visionRoute.providerId && visionRoute.modelId
      ? JSON.stringify([visionRoute.providerId, visionRoute.modelId])
      : '';
  const customVisionEnabled =
    customVisionDraft ??
    (visionRoute.enabled &&
      (defaultVisionModel
        ? selectedVisionKey !== defaultVisionModel.key
        : visionRoute.modelId !== DEFAULT_IMAGE_MODEL));
  const effectiveVisionRoute: CodeProVisionRoute = customVisionEnabled
    ? { ...visionRoute, enabled: true, mode: 'auto' }
    : {
        enabled: true,
        mode: 'auto',
        providerId: defaultVisionModel?.providerId,
        modelId: defaultVisionModel?.id,
      };
  const requestedVisionModels = useMemo(
    () =>
      visionOnly && !customVisionEnabled
        ? defaultVisionModel
          ? [defaultVisionModel]
          : []
        : visionInventory,
    [visionOnly, customVisionEnabled, defaultVisionModel, visionInventory]
  );
  const [visionCapabilities, setVisionCapabilities] = useState<{
    inventory?: typeof requestedVisionModels;
    status: 'loading' | 'ready' | 'unavailable';
    models: Record<string, ModelCapabilityState>;
  }>({ status: 'loading', models: {} });
  const checkVision = (advancedRoutingEnabled || visionOnly) && (visionRoute.enabled || visionOnly);
  useEffect(() => {
    let current = true;
    setVisionCapabilities({ inventory: requestedVisionModels, status: 'loading', models: {} });
    if (!checkVision || !modelDiscoveryComplete) return;
    void Promise.allSettled(
      requestedVisionModels.map(async (model) => ({
        key: model.key,
        capability: await resolveModelCapability(model.providerId, model.id),
      }))
    ).then((results) => {
      if (!current) return;
      const models = Object.fromEntries(
        results.flatMap((result) =>
          result.status === 'fulfilled'
            ? [[result.value.key, result.value.capability.imageInput]]
            : []
        )
      );
      setVisionCapabilities({
        inventory: requestedVisionModels,
        models,
        status:
          results.some((result) => result.status === 'rejected') &&
          !Object.values(models).includes('supported')
            ? 'unavailable'
            : 'ready',
      });
    });
    return () => {
      current = false;
    };
  }, [checkVision, requestedVisionModels, modelLoadAttempt, modelDiscoveryComplete]);
  const visionCapabilitiesCurrent = visionCapabilities.inventory === requestedVisionModels;
  const visionModels = visionCapabilitiesCurrent
    ? visionInventory.filter((model) => visionCapabilities.models[model.key] === 'supported')
    : [];
  const visionChecking =
    !modelDiscoveryComplete ||
    !visionCapabilitiesCurrent ||
    visionCapabilities.status === 'loading';
  const [saving, setSaving] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState('');
  const currentDefaultProvider = currentDefault?.provider;
  const currentDefaultModel = currentDefault?.model;
  const modelLoadError = intl.formatMessage(i18n.loadError);

  useEffect(() => {
    let cancelled = false;
    setConfigurationLoaded(false);
    const defaultsPromise =
      currentDefaultProvider !== undefined
        ? Promise.resolve({
            providerId: currentDefaultProvider,
            modelId: currentDefaultModel,
          })
        : acpReadDefaults();
    // Hydrate the draft once, before editing. Catalog discovery must never write user settings.
    void Promise.all([readCodeProModelRouting(), acpListProviderDetails(), defaultsPromise])
      .then(([savedRouting, providerList, defaults]) => {
        if (cancelled) return;
        const disabledIds = new Set(
          providerList
            .filter((provider) => providerActivationDisabledReason(provider) !== null)
            .map((provider) => provider.name)
        );
        setActivationDisabledProviderIds(disabledIds);
        const activeProviders = providerList.filter(
          (provider) =>
            provider.is_configured &&
            provider.provider_type === 'Custom' &&
            provider.category !== 'agent' &&
            !disabledIds.has(provider.name)
        );
        setProviders(activeProviders);
        const defaultModel = {
          provider: defaults.providerId?.trim() ?? '',
          model: defaults.modelId?.trim() ?? '',
        };
        const next = selectionsFromDefault(defaultModel);
        const enabled = savedRouting?.advancedRoutingEnabled === true;
        if (savedRouting) {
          for (const route of savedRouting.routes) {
            next[route.role] = { provider: route.providerId, model: route.modelId };
          }
        }
        setDefaultSelection(defaultModel);
        setSelections(next);
        setAdvancedRoutingEnabled(enabled);
        setVisionRoute(savedRouting?.visionRoute ?? DISABLED_CODEPRO_MODEL_ROUTING.visionRoute);
        setConfigurationLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setOperationError(modelLoadError);
      });
    return () => {
      cancelled = true;
    };
  }, [currentDefaultProvider, currentDefaultModel, modelLoadError]);

  const selectedProvidersKey = providers
    .filter(() => advancedRoutingEnabled || visionOnly)
    .map((provider) => provider.name)
    .filter((provider) => !activationDisabledProviderIds.has(provider))
    .join('\0');

  useEffect(() => {
    const requestGeneration = ++modelRequestGeneration.current;
    if (!selectedProvidersKey) {
      setModelDiscoveryComplete(advancedRoutingEnabled || visionOnly);
      return;
    }
    setModelDiscoveryComplete(false);
    const providersToLoad = selectedProvidersKey.split('\0');
    const loadingState: ProviderDiscoveryState = modelLoadAttempt > 0 ? 'retrying' : 'loading';
    setProviderDiscoveryState((current) => ({
      ...current,
      ...Object.fromEntries(providersToLoad.map((provider) => [provider, loadingState])),
    }));
    let remaining = providersToLoad.length;
    let successful = 0;
    const completeOne = () => {
      remaining -= 1;
      if (remaining !== 0 || requestGeneration !== modelRequestGeneration.current) return;
      setModelDiscoveryComplete(true);
      setDiscoveryError(successful < providersToLoad.length ? modelLoadError : '');
    };
    providersToLoad.forEach((provider) => {
      void acpListProviderModels(provider)
        .then((models) => {
          if (requestGeneration !== modelRequestGeneration.current) return;
          if (models.length === 0) throw new Error('provider returned no models');
          successful += 1;
          setModelsByProvider((current) => {
            return { ...current, [provider]: models };
          });
          setProviderDiscoveryState((current) => ({ ...current, [provider]: 'ready' }));
          setDiscoveryError('');
        })
        .catch(() => {
          if (requestGeneration !== modelRequestGeneration.current) return;
          setModelsByProvider((current) => {
            return { ...current, [provider]: [] };
          });
          setProviderDiscoveryState((current) => ({ ...current, [provider]: 'unavailable' }));
        })
        .finally(completeOne);
    });
  }, [advancedRoutingEnabled, visionOnly, modelLoadError, modelLoadAttempt, selectedProvidersKey]);

  const providerOptions = modelDiscoveryComplete
    ? providers.filter((provider) => (modelsByProvider[provider.name]?.length ?? 0) > 0)
    : providers;

  const providerDiscoveryLabel = (state: ProviderDiscoveryState | undefined) => {
    switch (state) {
      case 'ready':
        return intl.formatMessage(i18n.providerReady);
      case 'unavailable':
        return intl.formatMessage(i18n.providerUnavailable);
      case 'retrying':
        return intl.formatMessage(i18n.providerRetrying);
      case 'loading':
      default:
        return intl.formatMessage(i18n.providerLoading);
    }
  };

  const updateSelection = (role: CodeProAgentRole, selection: AgentModelSelection) => {
    setDuplicateWarning('');
    setOperationError('');
    setSelections((current) => ({ ...current, [role]: selection }));
  };

  const invalidSelectionMessage = () => {
    for (const role of roles) {
      const selection = selections[role.role];
      if (!selection.provider || !selection.model) {
        return intl.formatMessage(i18n.missingSelection, { role: role.label });
      }

      const provider = providers.find((candidate) => candidate.name === selection.provider);
      if (!provider) {
        return intl.formatMessage(i18n.providerRemoved, {
          role: role.label,
          provider: selection.provider,
        });
      }

      const providerLabel = provider.metadata.display_name || provider.name;
      const discoveryState = providerDiscoveryState[provider.name];
      if (discoveryState === 'loading' || discoveryState === 'retrying') {
        return intl.formatMessage(i18n.providerModelsLoading, { provider: providerLabel });
      }
      if (discoveryState === 'unavailable') {
        return intl.formatMessage(i18n.providerModelsUnavailable, {
          role: role.label,
          provider: providerLabel,
        });
      }

      const knownModels = modelsByProvider[provider.name];
      if (!knownModels?.some((model) => model.id === selection.model)) {
        return intl.formatMessage(i18n.modelUnavailable, {
          role: role.label,
          model: selection.model,
          provider: providerLabel,
        });
      }
    }
    return '';
  };

  const invalidVisionSelectionMessage = (selection = visionRoute) => {
    if (!selection.enabled) return '';
    const role = intl.formatMessage(i18n.visionAgent);
    if (!selection.providerId || !selection.modelId) {
      if (visionOnly && !customVisionEnabled)
        return intl.formatMessage(i18n.visionDefaultUnavailable);
      return intl.formatMessage(i18n.missingSelection, { role });
    }
    const provider = providers.find((candidate) => candidate.name === selection.providerId);
    if (!provider) {
      return intl.formatMessage(i18n.providerRemoved, {
        role,
        provider: selection.providerId,
      });
    }
    const providerLabel = provider.metadata.display_name || provider.name;
    const discoveryState = providerDiscoveryState[provider.name];
    if (discoveryState === 'loading' || discoveryState === 'retrying') {
      return intl.formatMessage(i18n.providerModelsLoading, { provider: providerLabel });
    }
    if (discoveryState === 'unavailable') {
      return intl.formatMessage(i18n.providerModelsUnavailable, { role, provider: providerLabel });
    }
    if (!modelsByProvider[provider.name]?.some((model) => model.id === selection.modelId)) {
      return intl.formatMessage(i18n.modelUnavailable, {
        role,
        model: selection.modelId,
        provider: providerLabel,
      });
    }
    if (visionChecking) return intl.formatMessage(i18n.visionChecking);
    if (visionCapabilities.status === 'unavailable')
      return intl.formatMessage(i18n.visionCapabilityError);
    if (
      !visionModels.some(
        (model) => model.key === JSON.stringify([selection.providerId, selection.modelId])
      )
    )
      return intl.formatMessage(i18n.visionUnsupported);
    return '';
  };

  const findDuplicateGroups = () => {
    const rolesByModel = new Map<string, { labels: string[]; model: string }>();
    for (const role of roles) {
      const selected = selections[role.role];
      if (!selected.model) continue;
      const normalizedModel = selected.model.trim().toLowerCase();
      if (!normalizedModel) continue;
      const group = rolesByModel.get(normalizedModel) ?? {
        labels: [],
        model: selected.model,
      };
      group.labels.push(role.label);
      rolesByModel.set(normalizedModel, group);
    }

    const groups = [...rolesByModel.values()]
      .filter((group) => group.labels.length > 1)
      .map((group) =>
        intl.formatMessage(i18n.duplicateGroup, {
          roles: intl.formatList(group.labels),
          model: group.model,
        })
      );
    return groups.length > 0 ? intl.formatList(groups) : '';
  };

  const save = async () => {
    if (!configurationLoaded || saving) return;
    const visionSelectionError =
      advancedRoutingEnabled || visionOnly
        ? invalidVisionSelectionMessage(visionOnly ? effectiveVisionRoute : visionRoute)
        : '';
    if (visionSelectionError) {
      setOperationError(visionSelectionError);
      return;
    }
    if (visionOnly) {
      setSaving(true);
      setOperationError('');
      try {
        const latest = await readCodeProModelRouting();
        await saveCodeProModelRouting({
          ...(latest ?? DISABLED_CODEPRO_MODEL_ROUTING),
          visionRoute: { ...effectiveVisionRoute },
        });
        onClose();
      } catch (error) {
        const data = acpErrorData(error);
        setOperationError(
          typeof data === 'object' &&
            data !== null &&
            'kind' in data &&
            data.kind === 'vision_error'
            ? errorMessage(error)
            : intl.formatMessage(i18n.saveError)
        );
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!advancedRoutingEnabled) {
      setSaving(true);
      setOperationError('');
      try {
        await saveCodeProModelRouting({
          version: 2,
          advancedRoutingEnabled: false,
          // Only complete pairs are preferences. Availability is checked when enabling.
          routes: roles.flatMap(({ role }) => {
            const { provider, model } = selections[role];
            return provider && model ? [{ role, providerId: provider, modelId: model }] : [];
          }),
          visionRoute: { ...visionRoute },
          maxParallelCoders: 1,
        });
        onClose();
      } catch {
        setOperationError(intl.formatMessage(i18n.saveError));
      } finally {
        setSaving(false);
      }
      return;
    }

    const selectionError = invalidSelectionMessage();
    if (selectionError) {
      setOperationError(selectionError);
      return;
    }

    const duplicateGroups = findDuplicateGroups();
    if (duplicateGroups && !duplicateWarning) {
      setDuplicateWarning(duplicateGroups);
      return;
    }

    setSaving(true);
    setOperationError('');
    try {
      const config: CodeProModelRoutingConfig = {
        version: 2,
        advancedRoutingEnabled: true,
        routes: roles.map((role) => ({
          role: role.role,
          providerId: selections[role.role].provider,
          modelId: selections[role.role].model,
        })),
        visionRoute: { ...visionRoute },
        maxParallelCoders: 1,
      };
      await saveCodeProModelRouting(config);
      onClose();
    } catch {
      setOperationError(intl.formatMessage(i18n.saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            {intl.formatMessage(visionOnly ? i18n.visionAgent : i18n.title)}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage(visionOnly ? i18n.visionAgentDescription : i18n.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto py-2 pr-1">
          {!configurationLoaded && !operationError && (
            <p role="status" className="text-sm text-text-secondary">
              {intl.formatMessage(i18n.providerLoading)}
            </p>
          )}
          {configurationLoaded && !visionOnly && (
            <section className="rounded-lg border border-border-primary bg-background-secondary p-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <input
                  type="checkbox"
                  disabled={!configurationLoaded || saving}
                  checked={advancedRoutingEnabled}
                  onChange={(event) => {
                    // Toggling changes the mode, not the user's saved or edited draft.
                    setAdvancedRoutingEnabled(event.target.checked);
                    setOperationError('');
                    setDuplicateWarning('');
                  }}
                />
                {intl.formatMessage(i18n.advancedRouting)}
              </label>
              {!advancedRoutingEnabled && (
                <p className="mt-2 text-xs text-text-secondary">
                  {intl.formatMessage(i18n.disabledRoutingHint)}
                </p>
              )}
              {advancedRoutingEnabled && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
                  {providers.map((provider) => (
                    <span key={provider.name}>
                      {provider.metadata.display_name || provider.name}:{' '}
                      {providerDiscoveryLabel(providerDiscoveryState[provider.name])}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}
          {configurationLoaded &&
            !visionOnly &&
            roles.map((role) => {
              const selection = selections[role.role];
              const effectiveProvider = selection.provider || defaultSelection.provider;
              const availableModels = modelsByProvider[effectiveProvider] ?? [];
              const selectedProvider = providers.find(
                (provider) => provider.name === selection.provider
              );
              const selectedProviderIsUnavailable =
                Boolean(selectedProvider) &&
                !providerOptions.some((provider) => provider.name === selection.provider);
              const currentProviderLabel =
                providers.find((provider) => provider.name === defaultSelection.provider)?.metadata
                  .display_name || defaultSelection.provider;
              const selectedProviderLabel =
                selectedProvider?.metadata.display_name || selection.provider;
              const modelOptions =
                selection.model && !availableModels.some((model) => model.id === selection.model)
                  ? [{ id: selection.model, name: selection.model }, ...availableModels]
                  : availableModels;
              return (
                <section
                  key={role.role}
                  className="rounded-lg border border-border-primary bg-background-secondary p-3"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">{role.label}</h3>
                      <p className="text-xs text-text-secondary">{role.description}</p>
                    </div>
                  </div>
                  {advancedRoutingEnabled ? (
                    <>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <select
                          disabled={saving}
                          aria-label={intl.formatMessage(i18n.providerLabel, { role: role.label })}
                          value={selection.provider}
                          onChange={(event) => {
                            if (event.target.value === CONFIGURE_PROVIDER_VALUE) {
                              onConfigureProvider?.();
                              return;
                            }
                            updateSelection(role.role, { provider: event.target.value, model: '' });
                          }}
                          className="h-10 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary"
                        >
                          <option value="">{intl.formatMessage(i18n.systemDefault)}</option>
                          {selection.provider &&
                            !providers.some((provider) => provider.name === selection.provider) && (
                              <option value={selection.provider}>{selection.provider}</option>
                            )}
                          {selection.provider &&
                            selectedProviderIsUnavailable &&
                            selectedProvider && (
                              <option value={selection.provider}>
                                {intl.formatMessage(i18n.unavailableProviderOption, {
                                  provider:
                                    selectedProvider.metadata.display_name || selectedProvider.name,
                                })}
                              </option>
                            )}
                          {providerOptions.map((provider) => (
                            <option key={provider.name} value={provider.name}>
                              {provider.metadata.display_name || provider.name}
                            </option>
                          ))}
                          <option value={CONFIGURE_PROVIDER_VALUE}>
                            {intl.formatMessage(i18n.useAnotherProvider)}
                          </option>
                        </select>
                        <select
                          aria-label={intl.formatMessage(i18n.modelLabel, { role: role.label })}
                          disabled={saving}
                          value={selection.model}
                          onChange={(event) =>
                            updateSelection(role.role, {
                              provider: effectiveProvider,
                              model: event.target.value,
                            })
                          }
                          className="h-10 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary"
                        >
                          <option value="">{intl.formatMessage(i18n.selectModel)}</option>
                          {modelOptions.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name || model.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="mt-2 text-xs text-text-secondary">
                        {intl.formatMessage(i18n.actualModel, {
                          provider: selectedProviderLabel,
                          model: selection.model,
                        })}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-text-secondary">
                      {intl.formatMessage(i18n.followsCurrentModel, {
                        provider: currentProviderLabel,
                        model: defaultSelection.model,
                      })}
                    </p>
                  )}
                </section>
              );
            })}
          {configurationLoaded &&
            (visionOnly ? (
              <section className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <label htmlFor="custom-image-model" className="text-sm text-text-primary">
                    {intl.formatMessage(i18n.customVision)}
                  </label>
                  <Switch
                    id="custom-image-model"
                    variant="mono"
                    checked={customVisionEnabled}
                    disabled={saving}
                    onCheckedChange={(checked) => {
                      setCustomVisionDraft(checked);
                      setOperationError('');
                    }}
                  />
                </div>
                {!customVisionEnabled && (
                  <p className="text-sm text-text-secondary">
                    {intl.formatMessage(i18n.visionDefault, {
                      model: defaultVisionModel
                        ? `${defaultVisionModel.name || defaultVisionModel.id} · ${defaultVisionModel.providerLabel}`
                        : DEFAULT_IMAGE_MODEL,
                    })}
                  </p>
                )}
                {visionChecking ? (
                  <p role="status" className="text-sm text-text-secondary">
                    {intl.formatMessage(i18n.visionChecking)}
                  </p>
                ) : customVisionEnabled ? (
                  <fieldset
                    className="space-y-3 rounded-2xl border border-border-primary px-4 pb-3 pt-2"
                    disabled={saving}
                  >
                    <legend className="px-1 text-sm text-text-secondary">
                      {intl.formatMessage(i18n.visionModelLabel)}
                    </legend>
                    {providers.map((provider) => {
                      const models = visionModels.filter(
                        (model) => model.providerId === provider.name
                      );
                      if (!models.length) return null;
                      return (
                        <div
                          key={provider.name}
                          role="group"
                          aria-label={provider.metadata.display_name || provider.name}
                          className="space-y-1"
                        >
                          <p className="text-xs font-semibold text-text-secondary">
                            {provider.metadata.display_name || provider.name}
                          </p>
                          {models.map((model) => (
                            <label
                              key={model.key}
                              className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-2 hover:bg-background-secondary"
                            >
                              <input
                                type="radio"
                                name="auxiliary-image-model"
                                aria-label={model.name || model.id}
                                checked={selectedVisionKey === model.key}
                                onChange={() => {
                                  setVisionRoute({
                                    enabled: true,
                                    mode: 'auto',
                                    providerId: model.providerId,
                                    modelId: model.id,
                                  });
                                  setOperationError('');
                                }}
                                className="mt-1 shrink-0 accent-black dark:accent-white"
                              />
                              <span className="min-w-0 text-sm text-text-primary">
                                <span className="block break-words">{model.name || model.id}</span>
                                {model.name && model.name !== model.id && (
                                  <span className="block break-words text-xs text-text-secondary">
                                    {model.id}
                                  </span>
                                )}
                              </span>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                    {visionModels.length === 0 && (
                      <p role="status" className="text-sm text-text-secondary">
                        {intl.formatMessage(
                          visionCapabilities.status === 'unavailable'
                            ? i18n.visionCapabilityError
                            : i18n.visionNoModels
                        )}
                      </p>
                    )}
                  </fieldset>
                ) : (
                  !defaultVisionModel && (
                    <p role="status" className="text-sm text-text-secondary">
                      {intl.formatMessage(i18n.visionDefaultUnavailable)}
                    </p>
                  )
                )}
                {!visionChecking &&
                  effectiveVisionRoute.providerId &&
                  effectiveVisionRoute.modelId &&
                  !visionModels.some(
                    (model) =>
                      model.key ===
                      JSON.stringify([
                        effectiveVisionRoute.providerId,
                        effectiveVisionRoute.modelId,
                      ])
                  ) && (
                    <p role="status" className="text-sm text-text-secondary">
                      {intl.formatMessage(
                        visionCapabilities.models[
                          JSON.stringify([
                            effectiveVisionRoute.providerId,
                            effectiveVisionRoute.modelId,
                          ])
                        ] === 'unsupported'
                          ? i18n.visionUnsupportedSelection
                          : i18n.visionUnavailableSelection,
                        { model: effectiveVisionRoute.modelId }
                      )}
                    </p>
                  )}
                {customVisionEnabled && onConfigureProvider && (
                  <Button type="button" variant="outline" onClick={onConfigureProvider}>
                    {intl.formatMessage(i18n.useAnotherProvider)}
                  </Button>
                )}
              </section>
            ) : (
              <section className="rounded-lg border border-border-primary bg-background-secondary p-3">
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {intl.formatMessage(i18n.visionAgent)}
                  </h3>
                  <p className="text-xs text-text-secondary">
                    {intl.formatMessage(i18n.visionAgentDescription)}
                  </p>
                </div>
                {advancedRoutingEnabled || visionOnly ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <select
                      aria-label={intl.formatMessage(i18n.providerLabel, {
                        role: intl.formatMessage(i18n.visionAgent),
                      })}
                      value={visionRoute.providerId ?? ''}
                      onChange={(event) => {
                        if (event.target.value === CONFIGURE_PROVIDER_VALUE) {
                          onConfigureProvider?.();
                          return;
                        }
                        if (!event.target.value) {
                          setVisionRoute({ enabled: false, mode: 'disabled' });
                          return;
                        }
                        setVisionRoute({
                          ...visionRoute,
                          enabled: true,
                          mode: 'auto',
                          providerId: event.target.value,
                          modelId: undefined,
                        });
                      }}
                      className="h-10 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary"
                    >
                      <option value="">{intl.formatMessage(i18n.visionDefaultProvider)}</option>
                      {visionRoute.providerId &&
                        !providers.some((provider) => provider.name === visionRoute.providerId) && (
                          <option value={visionRoute.providerId}>
                            {providers.find((provider) => provider.name === visionRoute.providerId)
                              ? intl.formatMessage(i18n.unavailableProviderOption, {
                                  provider:
                                    providers.find(
                                      (provider) => provider.name === visionRoute.providerId
                                    )?.metadata.display_name || visionRoute.providerId,
                                })
                              : visionRoute.providerId}
                          </option>
                        )}
                      {providers.map((provider) => (
                        <option key={provider.name} value={provider.name}>
                          {provider.metadata.display_name || provider.name}
                        </option>
                      ))}
                      <option value={CONFIGURE_PROVIDER_VALUE}>
                        {intl.formatMessage(i18n.useAnotherProvider)}
                      </option>
                    </select>
                    <select
                      aria-label={intl.formatMessage(i18n.visionModelLabel)}
                      value={visionRoute.providerId ? (visionRoute.modelId ?? '') : ''}
                      disabled={!visionRoute.providerId || visionChecking}
                      onChange={(event) => {
                        if (!visionRoute.providerId) return;
                        setVisionRoute({
                          ...visionRoute,
                          providerId: visionRoute.providerId,
                          modelId: event.target.value || undefined,
                        });
                      }}
                      className="h-10 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary disabled:opacity-100"
                    >
                      <option value="">
                        {visionRoute.providerId
                          ? intl.formatMessage(
                              visionChecking ? i18n.visionChecking : i18n.selectModel
                            )
                          : intl.formatMessage(i18n.visionDefaultModel)}
                      </option>
                      {visionRoute.providerId &&
                        visionRoute.modelId &&
                        !visionModels.some((model) => model.key === selectedVisionKey) && (
                          <option value={visionRoute.modelId} disabled>
                            {intl.formatMessage(
                              visionChecking
                                ? i18n.visionChecking
                                : i18n.visionUnavailableSelection,
                              {
                                model: visionRoute.modelId,
                              }
                            )}
                          </option>
                        )}
                      {visionRoute.providerId &&
                        visionModels
                          .filter((model) => model.providerId === visionRoute.providerId)
                          .map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name || model.id}
                            </option>
                          ))}
                    </select>
                    <p className="text-xs text-text-secondary sm:col-span-2">
                      {intl.formatMessage(i18n.visionSupportedOnly)}
                    </p>
                    {visionRoute.providerId && !visionChecking && visionModels.length === 0 && (
                      <p role="status" className="text-xs text-text-secondary sm:col-span-2">
                        {intl.formatMessage(
                          visionCapabilities.status === 'unavailable'
                            ? i18n.visionCapabilityError
                            : i18n.visionNoModels
                        )}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-text-secondary">
                    {visionRoute.providerId
                      ? providers.find((provider) => provider.name === visionRoute.providerId)
                          ?.metadata.display_name || visionRoute.providerId
                      : intl.formatMessage(i18n.visionDefaultProvider)}{' '}
                    / {visionRoute.modelId || intl.formatMessage(i18n.visionDefaultModel)}
                  </p>
                )}
              </section>
            ))}
        </div>

        {duplicateWarning && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-text-primary"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
            <p>
              {intl.formatMessage(i18n.duplicateWarning, {
                groups: duplicateWarning,
              })}
            </p>
          </div>
        )}

        {operationError && <p className="text-sm text-red-600">{operationError}</p>}

        {(advancedRoutingEnabled || visionOnly) &&
          discoveryError &&
          discoveryError !== operationError && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-red-600">{discoveryError}</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDiscoveryError('');
                  setModelsByProvider((current) =>
                    Object.fromEntries(
                      Object.entries(current).filter(([, models]) => models.length > 0)
                    )
                  );
                  setModelLoadAttempt((attempt) => attempt + 1);
                }}
              >
                {intl.formatMessage(i18n.retry)}
              </Button>
            </div>
          )}

        <DialogFooter className="gap-2 sm:justify-end">
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button type="button" onClick={save} disabled={saving || !configurationLoaded}>
              {saving
                ? intl.formatMessage(i18n.saving)
                : intl.formatMessage(
                    visionOnly ? i18n.saveVision : duplicateWarning ? i18n.saveAnyway : i18n.save
                  )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
