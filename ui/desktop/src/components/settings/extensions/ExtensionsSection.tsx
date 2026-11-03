import { useEffect, useState, useCallback, useMemo } from 'react';
import { Button } from '../../ui/button';
import { Plus } from 'lucide-react';
import { useConfig, FixedExtensionEntry } from '../../ConfigContext';
import { defineMessages, useIntl } from '../../../i18n';
import ExtensionList from './subcomponents/ExtensionList';
import ExtensionModal from './modal/ExtensionModal';
import {
  createExtensionConfig,
  ExtensionFormData,
  extensionToFormData,
  getDefaultFormData,
  nameToKey,
} from './utils';

import { activateExtensionDefault, deleteExtension, toggleExtensionDefault } from './index';
import type { ExtensionConfig } from '../../../types/extensions';
import { getExtensionOperationMessages } from './extension-operation-messages';
import { testConfigExtension } from '../../../acp/extensions';
import { getInitialWorkingDir } from '../../../utils/workingDir';
import { isConfigurableBundledExtension } from './bundled-extensions';

const i18n = defineMessages({
  addCustomExtension: {
    id: 'extensionsSection.addCustomExtension',
    defaultMessage: 'Add custom extension',
  },
  updateExtension: {
    id: 'extensionsSection.updateExtension',
    defaultMessage: 'Update Extension',
  },
  saveChanges: {
    id: 'extensionsSection.saveChanges',
    defaultMessage: 'Save Changes',
  },
  addExtension: {
    id: 'extensionsSection.addExtension',
    defaultMessage: 'Add Extension',
  },
});

interface ExtensionSectionProps {
  deepLinkConfig?: ExtensionConfig;
  showEnvVars?: boolean;
  hideButtons?: boolean;
  disableConfiguration?: boolean;
  customToggle?: (extension: FixedExtensionEntry) => Promise<boolean | void>;
  selectedExtensions?: string[]; // Add controlled state
  onModalClose?: (extensionName: string) => void;
  searchTerm?: string;
  allowedTypes?: ExtensionConfig['type'][];
  hideList?: boolean;
  controlledExtension?: FixedExtensionEntry;
  controlledAddOpen?: boolean;
  onControlledRequestClose?: () => void;
}

export default function ExtensionsSection({
  deepLinkConfig,
  showEnvVars,
  hideButtons,
  disableConfiguration,
  customToggle,
  selectedExtensions = [],
  onModalClose,
  searchTerm = '',
  allowedTypes,
  hideList = false,
  controlledExtension,
  controlledAddOpen = false,
  onControlledRequestClose,
}: ExtensionSectionProps) {
  const intl = useIntl();
  const {
    getExtensions,
    addExtension,
    updateExtension,
    removeExtension,
    setExtensionEnabled,
    extensionsList,
  } = useConfig();
  const [listSelection, setSelectedExtension] = useState<FixedExtensionEntry | null>(null);
  const selectedExtension = controlledExtension ?? listSelection;
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [deepLinkConfigStateVar, setDeepLinkConfigStateVar] = useState<
    ExtensionConfig | undefined | null
  >(deepLinkConfig);
  const [showEnvVarsStateVar, setShowEnvVarsStateVar] = useState<boolean | undefined | null>(
    showEnvVars
  );

  useEffect(() => {
    setDeepLinkConfigStateVar(deepLinkConfig);
    setShowEnvVarsStateVar(showEnvVars);
  }, [deepLinkConfig, showEnvVars]);

  const extensions = useMemo(() => {
    if (extensionsList.length === 0) return [];

    return extensionsList
      .filter((extension) => !allowedTypes || allowedTypes.includes(extension.type))
      .sort((a, b) => {
        // First sort by builtin
        if (a.type === 'builtin' && b.type !== 'builtin') return -1;
        if (a.type !== 'builtin' && b.type === 'builtin') return 1;

        // Then sort by bundled (handle null/undefined cases)
        const aBundled = 'bundled' in a && a.bundled === true;
        const bBundled = 'bundled' in b && b.bundled === true;
        if (aBundled && !bBundled) return -1;
        if (!aBundled && bBundled) return 1;

        // Finally sort alphabetically within each group
        return a.name.localeCompare(b.name);
      })
      .map((ext) => ({
        ...ext,
        // Use selectedExtensions to determine enabled state in recipe editor
        enabled: disableConfiguration ? selectedExtensions.includes(ext.name) : ext.enabled,
      }));
  }, [extensionsList, disableConfiguration, selectedExtensions, allowedTypes]);

  useEffect(() => {
    if (controlledAddOpen && !isAddModalOpen) setIsAddModalOpen(true);
  }, [controlledAddOpen, isAddModalOpen]);

  const fetchExtensions = useCallback(async () => {
    await getExtensions(true); // Force refresh - this will update the context
  }, [getExtensions]);

  const handleExtensionToggle = async (extensionConfig: FixedExtensionEntry) => {
    if (customToggle) {
      await customToggle(extensionConfig);
      return true;
    }

    const toggleDirection = extensionConfig.enabled ? 'toggleOff' : 'toggleOn';
    const configKey = extensionConfig.configKey ?? nameToKey(extensionConfig.name);

    await toggleExtensionDefault({
      toggle: toggleDirection,
      extensionConfig: extensionConfig,
      setEnabled: (enabled) => setExtensionEnabled(configKey, enabled),
      messages: getExtensionOperationMessages(intl),
    });

    await fetchExtensions();
    return true;
  };

  const handleConfigureClick = (extension: FixedExtensionEntry) => {
    setSelectedExtension(extension);
  };

  const handleAddExtension = async (formData: ExtensionFormData) => {
    const extensionConfig = createExtensionConfig(formData);
    try {
      await activateExtensionDefault({
        addToConfig: addExtension,
        extensionConfig: extensionConfig,
        messages: getExtensionOperationMessages(intl),
      });
      await fetchExtensions();
      if (onModalClose) {
        setTimeout(() => {
          onModalClose(formData.name);
        }, 200);
      }
    } catch (error) {
      console.error('Failed to add extension:', error);
      throw error;
    }
  };

  const handleUpdateExtension = async (formData: ExtensionFormData) => {
    if (!selectedExtension) {
      console.error('No selected extension for update');
      return;
    }

    const extensionConfig = createExtensionConfig(formData);
    let configToSave: ExtensionConfig = extensionConfig;
    if (
      isConfigurableBundledExtension(selectedExtension) &&
      (extensionConfig.type === 'stdio' || extensionConfig.type === 'streamable_http')
    ) {
      configToSave = { ...extensionConfig, bundled: true };
    }
    try {
      await updateExtension(
        selectedExtension.configKey ?? nameToKey(selectedExtension.name),
        configToSave,
        formData.enabled
      );
      await fetchExtensions();
    } catch (error) {
      console.error('Failed to update extension:', error);
      throw error;
    }
  };

  const handleDeleteExtension = async (name: string) => {
    handleModalClose();

    try {
      await deleteExtension({
        name,
        removeFromConfig: removeExtension,
      });
    } catch (error) {
      console.error('Failed to delete extension:', error);
    } finally {
      await fetchExtensions();
    }
  };

  const handleModalClose = () => {
    setDeepLinkConfigStateVar(null);
    setShowEnvVarsStateVar(null);

    setIsAddModalOpen(false);
    setSelectedExtension(null);
    onControlledRequestClose?.();

    // Clear any navigation state that might be cached
    if (window.history.state?.deepLinkConfig) {
      window.history.replaceState({}, '', window.location.hash);
    }
  };

  return (
    <section id="extensions">
      <div className="">
        {!hideList && (
          <ExtensionList
            extensions={extensions}
            onToggle={handleExtensionToggle}
            onConfigure={handleConfigureClick}
            disableConfiguration={disableConfiguration}
            searchTerm={searchTerm}
          />
        )}

        {!hideButtons && (
          <div className="flex gap-4 pt-4 w-full">
            <Button
              className="flex items-center gap-2 justify-center"
              variant="default"
              onClick={() => setIsAddModalOpen(true)}
            >
              <Plus className="h-4 w-4" />
              {intl.formatMessage(i18n.addCustomExtension)}
            </Button>
          </div>
        )}

        {/* Modal for updating an existing extension */}
        {selectedExtension && (
          <ExtensionModal
            title={intl.formatMessage(i18n.updateExtension)}
            initialData={extensionToFormData(selectedExtension)}
            onClose={handleModalClose}
            onSubmit={handleUpdateExtension}
            onDelete={
              isConfigurableBundledExtension(selectedExtension)
                ? undefined
                : handleDeleteExtension
            }
            submitLabel={intl.formatMessage(i18n.saveChanges)}
            modalType={'edit'}
            baseConfigurationReadOnly={isConfigurableBundledExtension(selectedExtension)}
            onTest={(formData) =>
              testConfigExtension(
                createExtensionConfig(formData),
                Object.fromEntries(
                  formData.envVars
                    .filter((entry) => entry.isEdited && entry.key && entry.value)
                    .map((entry) => [entry.key, entry.value])
                ),
                getInitialWorkingDir()
              )
            }
          />
        )}

        {/* Modal for adding a new extension */}
        {isAddModalOpen && (
          <ExtensionModal
            title={intl.formatMessage(i18n.addCustomExtension)}
            initialData={getDefaultFormData()}
            onClose={handleModalClose}
            onSubmit={handleAddExtension}
            submitLabel={intl.formatMessage(i18n.addExtension)}
            modalType={'add'}
            onTest={(formData) =>
              testConfigExtension(
                createExtensionConfig(formData),
                Object.fromEntries(
                  formData.envVars
                    .filter((entry) => entry.isEdited && entry.key && entry.value)
                    .map((entry) => [entry.key, entry.value])
                ),
                getInitialWorkingDir()
              )
            }
          />
        )}

        {/* Modal for adding extension from deeplink*/}
        {deepLinkConfigStateVar && showEnvVarsStateVar && (
          <ExtensionModal
            title={intl.formatMessage(i18n.addCustomExtension)}
            initialData={extensionToFormData({
              ...deepLinkConfig,
              enabled: true,
            } as FixedExtensionEntry)}
            onClose={handleModalClose}
            onSubmit={handleAddExtension}
            submitLabel={intl.formatMessage(i18n.addExtension)}
            modalType={'add'}
          />
        )}
      </div>
    </section>
  );
}
