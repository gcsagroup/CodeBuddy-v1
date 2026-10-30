import React, { memo, useMemo, useCallback, useState } from 'react';
import { ProviderCard } from './subcomponents/ProviderCard';
import CardContainer from './subcomponents/CardContainer';
import ProviderConfigurationModal from './modal/ProviderConfigurationModal';
import type { CustomProviderConfigDto } from '@aaif/goose-sdk';
import {
  providerActivationDisabledReason,
  type ProviderDetails,
  type UpdateCustomProviderRequest,
} from '../../../types/providers';
import {
  acpCreateCustomProviderFromRequest,
  acpGetCustomProvider,
  acpDeleteCustomProvider,
  acpUpdateCustomProviderFromRequest,
  acpDiscoverCustomProviderModels,
} from '../../../acp/providers';
import { Plus, Search } from 'lucide-react';
import { Input } from '../../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog';
import CustomProviderForm from './modal/subcomponents/forms/CustomProviderForm';
import { SwitchModelModal } from '../models/subcomponents/SwitchModelModal';
import { useModelAndProvider } from '../../ModelAndProviderContext';
import type { View } from '../../../utils/navigationUtils';
import { defineMessages, useIntl } from '../../../i18n';
import { toast } from 'react-toastify';

const i18n = defineMessages({
  deletedRefreshFailed: {
    id: 'customProviderForm.deletedRefreshFailed',
    defaultMessage: 'Connection deleted, but the model list could not be refreshed. Reopen settings to refresh it.',
  },
  savedRefreshFailed: {
    id: 'providerGrid.savedRefreshFailed',
    defaultMessage: 'Connection verified and saved, but the model list could not be refreshed. Reopen settings to refresh it; do not add the connection again.',
  },
  addProvider: {
    id: 'providerGrid.addProvider',
    defaultMessage: 'Add Provider',
  },
  fromTemplateOrManual: {
    id: 'providerGrid.fromTemplateOrManual',
    defaultMessage: 'From template or manual setup',
  },
  localOrCompatibleEndpoint: {
    id: 'providerGrid.localOrCompatibleEndpoint',
    defaultMessage: 'Local or OpenAI-compatible model',
  },
  editProvider: {
    id: 'providerGrid.editProvider',
    defaultMessage: 'Edit Provider',
  },
  configureProvider: {
    id: 'providerGrid.configureProvider',
    defaultMessage: 'Configure Provider',
  },
  addProviderTitle: {
    id: 'providerGrid.addProviderTitle',
    defaultMessage: 'Add Provider',
  },
  chooseModel: {
    id: 'providerGrid.chooseModel',
    defaultMessage: 'Choose Model',
  },
  searchPlaceholder: {
    id: 'providerGrid.searchPlaceholder',
    defaultMessage: 'Search providers...',
  },
  noMatch: {
    id: 'providerGrid.noMatch',
    defaultMessage: 'No providers match "{query}"',
  },
});

const GridLayout = memo(function GridLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid gap-4 [&_*]:z-20 p-1"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 200px))',
        justifyContent: 'center',
      }}
    >
      {children}
    </div>
  );
});

const CustomProviderCard = memo(function CustomProviderCard({
  onClick,
  compactSetup,
}: {
  onClick: () => void;
  compactSetup: boolean;
}) {
  const intl = useIntl();
  return (
    <CardContainer
      testId="add-custom-provider-card"
      onClick={onClick}
      header={null}
      body={
        <div className="flex flex-col items-center justify-center min-h-[200px]">
          <Plus className="w-8 h-8 text-gray-400 mb-2" />
          <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
            <div className="font-medium">{intl.formatMessage(i18n.addProvider)}</div>
            <div className="text-xs text-gray-500 mt-1">
              {intl.formatMessage(
                compactSetup ? i18n.localOrCompatibleEndpoint : i18n.fromTemplateOrManual
              )}
            </div>
          </div>
        </div>
      }
      grayedOut={false}
      borderStyle="dashed"
    />
  );
});

function ProviderCards({
  providers,
  isOnboarding,
  refreshProviders,
  setView,
  onModelSelected,
  compactConnectionSetup,
}: {
  providers: ProviderDetails[];
  isOnboarding: boolean;
  refreshProviders?: () => void;
  setView?: (view: View) => void;
  onModelSelected?: (model?: string) => void;
  compactConnectionSetup?: boolean;
}) {
  const intl = useIntl();
  const [searchQuery, setSearchQuery] = useState('');
  const [configuringProvider, setConfiguringProvider] = useState<ProviderDetails | null>(null);
  const [showCustomProviderModal, setShowCustomProviderModal] = useState(false);
  const [showSwitchModelModal, setShowSwitchModelModal] = useState(false);
  const [switchModelSelection, setSwitchModelSelection] = useState<{
    provider: string;
    model?: string;
  } | null>(null);
  const { refreshCurrentModelAndProvider } = useModelAndProvider();
  const [editingProvider, setEditingProvider] = useState<{
    id: string;
    config: CustomProviderConfigDto;
    isEditable: boolean;
    providerType: string;
  } | null>(null);

  const handleProviderLaunchWithModelSelection = useCallback((provider: ProviderDetails) => {
    if (providerActivationDisabledReason(provider)) {
      return;
    }
    setSwitchModelSelection({ provider: provider.name });
    setShowSwitchModelModal(true);
  }, []);

  const openModal = useCallback(
    (provider: ProviderDetails) => setConfiguringProvider(provider),
    []
  );

  const configureProviderViaModal = useCallback(
    async (provider: ProviderDetails) => {
      if (providerActivationDisabledReason(provider)) {
        return;
      }
      if (provider.provider_type === 'Custom') {
        const result = await acpGetCustomProvider(provider.name);

        if (result) {
          setEditingProvider({
            id: provider.name,
            config: result.provider,
            isEditable: result.editable,
            providerType: provider.provider_type,
          });

          setShowCustomProviderModal(true);
        }
      } else {
        openModal(provider);
      }
    },
    [openModal]
  );

  const handleUpdateCustomProvider = useCallback(
    async (data: UpdateCustomProviderRequest) => {
      if (!editingProvider) return;

      await acpUpdateCustomProviderFromRequest(editingProvider.id, data);
      if (refreshProviders) {
        try { await refreshProviders(); }
        catch { toast.warning(intl.formatMessage(i18n.savedRefreshFailed)); }
      }
      setShowCustomProviderModal(false);
      setEditingProvider(null);
    },
    [editingProvider, refreshProviders, intl]
  );

  const handleDeleteCustomProvider = useCallback(async () => {
    if (!editingProvider) return;

    await acpDeleteCustomProvider(editingProvider.id);
    try {
      await refreshCurrentModelAndProvider();
      await refreshProviders?.();
    } catch {
      toast.warning(intl.formatMessage(i18n.deletedRefreshFailed));
    }
    setShowCustomProviderModal(false);
    setEditingProvider(null);
  }, [editingProvider, refreshProviders, refreshCurrentModelAndProvider, intl]);

  const handleCloseModal = useCallback(() => {
    setShowCustomProviderModal(false);
    setEditingProvider(null);
  }, []);

  const onCloseProviderConfig = useCallback(() => {
    setConfiguringProvider(null);
    if (refreshProviders) {
      refreshProviders();
    }
  }, [refreshProviders]);

  const onProviderConfigured = useCallback(async () => {
    if (refreshProviders) {
      await refreshProviders();
    }
    setConfiguringProvider(null);
  }, [refreshProviders]);

  const onCloseSwitchModelModal = useCallback(() => {
    setShowSwitchModelModal(false);
  }, []);

  const handleSetView = useCallback(
    (view: View) => {
      setShowSwitchModelModal(false);
      if (setView) {
        setView(view);
      }
    },
    [setView]
  );

  const handleCreateCustomProvider = useCallback(
    async (data: UpdateCustomProviderRequest) => {
      await acpCreateCustomProviderFromRequest(data);
      if (refreshProviders) {
        try { await refreshProviders(); }
        catch { toast.warning(intl.formatMessage(i18n.savedRefreshFailed)); }
      }
      setShowCustomProviderModal(false);
    },
    [refreshProviders, intl]
  );

  const query = searchQuery.trim().toLowerCase();

  const providerCards = useMemo(() => {
    // providers needs to be an array
    const providersArray = Array.isArray(providers) ? providers : [];
    // Sort providers alphabetically by display name
    const sortedProviders = [...providersArray].sort((a, b) =>
      a.metadata.display_name.localeCompare(b.metadata.display_name)
    );
    const filteredProviders = query
      ? sortedProviders.filter(
          (provider) =>
            provider.metadata.display_name.toLowerCase().includes(query) ||
            provider.metadata.description.toLowerCase().includes(query)
        )
      : sortedProviders;
    const cards = filteredProviders.map((provider) => (
      <ProviderCard
        key={provider.name}
        provider={provider}
        onConfigure={() => configureProviderViaModal(provider)}
        onLaunch={() => handleProviderLaunchWithModelSelection(provider)}
        isOnboarding={isOnboarding}
      />
    ));

    cards.push(
      <CustomProviderCard
        key="add-custom"
        onClick={() => setShowCustomProviderModal(true)}
        compactSetup={Boolean(compactConnectionSetup)}
      />
    );

    return cards;
  }, [
    providers,
    query,
    isOnboarding,
    configureProviderViaModal,
    handleProviderLaunchWithModelSelection,
    compactConnectionSetup,
  ]);

  const hasNoMatches =
    query.length > 0 &&
    providerCards.length === 1 &&
    (Array.isArray(providers) ? providers.length : 0) > 0;

  const initialData = editingProvider && {
    engine: editingProvider.config.engine,
    display_name: editingProvider.config.displayName,
    api_url: editingProvider.config.apiUrl,
    base_path: editingProvider.config.basePath ?? undefined,
    api_key: '',
    models: editingProvider.config.models ?? [],
    supports_streaming: editingProvider.config.supportsStreaming ?? true,
    requires_auth: editingProvider.config.requiresAuth ?? true,
    headers: editingProvider.config.headers ?? undefined,
    catalog_provider_id: editingProvider.config.catalogProviderId ?? undefined,
  };

  const editable = editingProvider ? editingProvider.isEditable : true;
  const title = editingProvider
    ? editable
      ? intl.formatMessage(i18n.editProvider)
      : intl.formatMessage(i18n.configureProvider)
    : intl.formatMessage(i18n.addProviderTitle);
  return (
    <>
      <div className="mx-auto mb-4 max-w-md px-1">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={intl.formatMessage(i18n.searchPlaceholder)}
            className="pl-9"
            data-testid="provider-search-input"
          />
        </div>
      </div>
      <GridLayout>{providerCards}</GridLayout>
      {hasNoMatches && (
        <div className="mt-2 text-center text-sm text-text-secondary">
          {intl.formatMessage(i18n.noMatch, { query: searchQuery.trim() })}
        </div>
      )}
      <Dialog open={showCustomProviderModal} onOpenChange={handleCloseModal}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <CustomProviderForm
            initialData={initialData}
            isEditable={editable}
            onSubmit={editingProvider ? handleUpdateCustomProvider : handleCreateCustomProvider}
            onCancel={handleCloseModal}
            onDelete={
              editingProvider?.providerType === 'Custom' ? handleDeleteCustomProvider : undefined
            }
            compactSetup={Boolean(compactConnectionSetup)}
            existingProviderNames={providers.map((provider) => provider.metadata.display_name)}
            discoverModels={(data) => acpDiscoverCustomProviderModels(data, editingProvider?.id)}
          />
        </DialogContent>
      </Dialog>
      {configuringProvider && (
        <ProviderConfigurationModal
          provider={configuringProvider}
          onClose={onCloseProviderConfig}
          onConfigured={onProviderConfigured}
        />
      )}
      {showSwitchModelModal && (
        <SwitchModelModal
          sessionId={null}
          onClose={onCloseSwitchModelModal}
          setView={handleSetView}
          onModelSelected={onModelSelected}
          initialProvider={switchModelSelection?.provider}
          initialModel={switchModelSelection?.model}
          titleOverride={intl.formatMessage(i18n.chooseModel)}
        />
      )}
    </>
  );
}

export default function ProviderGrid({
  providers,
  isOnboarding,
  refreshProviders,
  setView,
  onModelSelected,
  compactConnectionSetup = false,
}: {
  providers: ProviderDetails[];
  isOnboarding: boolean;
  refreshProviders?: () => void;
  setView?: (view: View) => void;
  onModelSelected?: (model?: string) => void;
  compactConnectionSetup?: boolean;
}) {
  return (
    <ProviderCards
      providers={providers}
      isOnboarding={isOnboarding}
      refreshProviders={refreshProviders}
      setView={setView}
      onModelSelected={onModelSelected}
      compactConnectionSetup={compactConnectionSetup}
    />
  );
}
