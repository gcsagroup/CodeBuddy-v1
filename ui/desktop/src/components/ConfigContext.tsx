import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { acpReadAllConfig, acpReadConfig, acpRemoveConfig, acpUpsertConfig } from '../acp/config';
import { acpListProviderDetails } from '../acp/providers';
import {
  getConfiguredExtensions,
  addConfigExtension,
  updateConfigExtension,
  removeConfigExtension,
  setConfigExtensionEnabled,
} from '../acp/extensions';
import { pruneDeprecatedBundledExtensions, syncBundledExtensions } from './settings/extensions';
import { enableManagedCapabilities } from './settings/extensions/managed-capabilities';
import { consolidateGitExtensions } from './settings/extensions/bundled-extensions';
import { connectGitHubMcp } from '../acp/diagnostics';
import { nameToKey } from './settings/extensions/utils';
import type { ExtensionConfig } from '../types/extensions';
import type { ProviderDetails } from '../types/providers';

export type { ExtensionConfig } from '../types/extensions';

// Define a local version that matches the structure of the imported one
export type FixedExtensionEntry = ExtensionConfig & {
  enabled: boolean;
  configKey?: string;
};

type ConfigMap = Record<string, unknown>;

interface ConfigContextType {
  config: ConfigMap;
  blockedMutationKeys: string[];
  providersList: ProviderDetails[];
  extensionsList: FixedExtensionEntry[];
  extensionWarnings: string[];
  upsert: (key: string, value: unknown, is_secret: boolean) => Promise<void>;
  read: (key: string, is_secret: boolean, options?: { throwOnError?: boolean }) => Promise<unknown>;
  remove: (key: string, is_secret: boolean) => Promise<void>;
  addExtension: (name: string, config: ExtensionConfig, enabled: boolean) => Promise<void>;
  updateExtension: (configKey: string, config: ExtensionConfig, enabled: boolean) => Promise<void>;
  setExtensionEnabled: (configKey: string, enabled: boolean) => Promise<void>;
  removeExtension: (name: string) => Promise<void>;
  getProviders: (b: boolean) => Promise<ProviderDetails[]>;
  getExtensions: (b: boolean) => Promise<FixedExtensionEntry[]>;
}

interface ConfigProviderProps {
  children: React.ReactNode;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

export const ConfigProvider: React.FC<ConfigProviderProps> = ({ children }) => {
  const [config, setConfig] = useState<ConfigMap>({});
  const [blockedMutationKeys, setBlockedMutationKeys] = useState<string[]>([]);
  const [providersList, setProvidersList] = useState<ProviderDetails[]>([]);
  const [extensionsList, setExtensionsList] = useState<FixedExtensionEntry[]>([]);
  const [extensionWarnings, setExtensionWarnings] = useState<string[]>([]);

  // Ref to access providersList in getProviders without recreating the callback
  const providersListRef = React.useRef<ProviderDetails[]>(providersList);
  providersListRef.current = providersList;

  const reloadConfig = useCallback(async () => {
    const response = await acpReadAllConfig();
    setConfig(response.config);
    setBlockedMutationKeys(response.blockedMutationKeys);
  }, []);

  const upsert = useCallback(
    async (key: string, value: unknown, isSecret: boolean = false) => {
      await acpUpsertConfig(key, value, isSecret);
      await reloadConfig();
    },
    [reloadConfig]
  );

  const read = useCallback(
    async (key: string, is_secret: boolean = false, options?: { throwOnError?: boolean }) => {
      try {
        return await acpReadConfig(key, is_secret);
      } catch (error) {
        if (options?.throwOnError) {
          throw error;
        }
        return null;
      }
    },
    []
  );

  const remove = useCallback(
    async (key: string, is_secret: boolean) => {
      await acpRemoveConfig(key, is_secret);
      await reloadConfig();
    },
    [reloadConfig]
  );

  const refreshExtensions = useCallback(async () => {
    const { extensions, warnings } = await getConfiguredExtensions();
    setExtensionsList(extensions);
    setExtensionWarnings(warnings || []);
    return extensions;
  }, []);

  const addExtension = useCallback(
    async (_name: string, config: ExtensionConfig, enabled: boolean) => {
      await addConfigExtension(config, enabled);
      await reloadConfig();
      // Refresh extensions list after successful addition
      await refreshExtensions();
    },
    [reloadConfig, refreshExtensions]
  );

  const removeExtension = useCallback(
    async (name: string) => {
      const entry = extensionsList.find((ext) => ext.name === name);
      await removeConfigExtension(entry?.configKey ?? nameToKey(name));
      await reloadConfig();
      // Refresh extensions list after successful removal
      await refreshExtensions();
    },
    [extensionsList, reloadConfig, refreshExtensions]
  );

  const updateExtension = useCallback(
    async (configKey: string, config: ExtensionConfig, enabled: boolean) => {
      await updateConfigExtension(configKey, config, enabled);
      await reloadConfig();
      await refreshExtensions();
    },
    [reloadConfig, refreshExtensions]
  );

  const getExtensions = useCallback(
    async (forceRefresh = false): Promise<FixedExtensionEntry[]> => {
      if (forceRefresh || extensionsList.length === 0) {
        return await refreshExtensions();
      }
      return extensionsList;
    },
    [extensionsList, refreshExtensions]
  );

  const setExtensionEnabled = useCallback(
    async (configKey: string, enabled: boolean) => {
      await setConfigExtensionEnabled(configKey, enabled);
      await reloadConfig();
      await refreshExtensions();
    },
    [reloadConfig, refreshExtensions]
  );

  const getProviders = useCallback(async (forceRefresh = false): Promise<ProviderDetails[]> => {
    if (forceRefresh || providersListRef.current.length === 0) {
      try {
        const providersData = await acpListProviderDetails();
        providersListRef.current = providersData;
        setProvidersList(providersData);
        return providersData;
      } catch (error) {
        console.error('Failed to fetch providers:', error);
        return providersListRef.current;
      }
    }
    return providersListRef.current;
  }, []);

  useEffect(() => {
    let disposed = false;
    let removeGrantListener: (() => void) | void;
    // Load all configuration data and providers on mount
    (async () => {
      // Load config
      const configResponse = await acpReadAllConfig();
      setConfig(configResponse.config);
      setBlockedMutationKeys(configResponse.blockedMutationKeys);

      // Load providers
      try {
        const providersData = await acpListProviderDetails();
        providersListRef.current = providersData;
        setProvidersList(providersData);
      } catch (error) {
        console.error('Failed to load providers:', error);
        setProvidersList([]);
      }

      // Load extensions
      try {
        const extensionsResponse = await getConfiguredExtensions();
        let extensions = extensionsResponse.extensions;
        const newGitHubConnection = !extensions.some(
          (entry) => (entry.configKey ?? entry.name) === 'github_official'
        );

        // Always sync bundled extensions from bundled-extensions.json
        // This ensures:
        // 1. Fresh installs get the default extensions (developer, computercontroller, etc.)
        // 2. Existing users get NEW bundled extensions added in subsequent releases
        // The syncBundledExtensions function skips extensions that already exist and are marked as bundled
        // Managed desktop capabilities are enabled below for new and existing profiles.
        const addExtensionForSync = async (
          _name: string,
          config: ExtensionConfig,
          enabled: boolean
        ) => {
          await addConfigExtension(config, enabled);
        };
        const removeExtensionForSync = async (configKey: string) => {
          await removeConfigExtension(configKey);
        };
        extensions = await pruneDeprecatedBundledExtensions(extensions, removeExtensionForSync);
        await syncBundledExtensions(extensions, addExtensionForSync);
        await consolidateGitExtensions(extensions, setConfigExtensionEnabled);
        await enableManagedCapabilities(
          (await getConfiguredExtensions()).extensions,
          setConfigExtensionEnabled,
          addConfigExtension
        );
        // Reload extensions after sync
        const refreshedResponse = await getConfiguredExtensions();
        extensions = refreshedResponse.extensions;

        setExtensionsList(extensions);
        setExtensionWarnings(extensionsResponse.warnings || []);
        // Fresh installs can reuse the user's existing login. Never replace an
        // existing connection, custom endpoint or explicit disabled preference.
        if (newGitHubConnection && typeof window.electron.githubCliStatus === 'function') {
          let checked = false;
          const connectAfterConsent = async () => {
            const allowed = await window.electron.getSetting('networkAccessAllowed');
            if (!allowed || disposed || checked) return;
            checked = true;
            removeGrantListener?.();
            const current = (await getConfiguredExtensions()).extensions.find(e => (e.configKey ?? e.name) === 'github_official');
            if (!current?.enabled || current.type !== 'streamable_http' || current.uri !== 'https://api.githubcopilot.com/mcp/') return;
            const account = await window.electron.githubCliStatus();
            if (!disposed && account.state === 'connected' && account.login) {
              const result = await connectGitHubMcp(account.login);
              if (!disposed && result.success) await refreshExtensions();
            }
          };
          const attempt = () => { void connectAfterConsent().catch(() => {}); };
          if (!disposed) {
            removeGrantListener = window.electron.on('network-access-granted', attempt);
            attempt();
          }
        }
      } catch (error) {
        console.error('Failed to load extensions:', error);
      }
    })();
    return () => { disposed = true; removeGrantListener?.(); };
  }, [refreshExtensions]);

  const contextValue = useMemo(() => {
    return {
      config,
      blockedMutationKeys,
      providersList,
      extensionsList,
      extensionWarnings,
      upsert,
      read,
      remove,
      addExtension,
      updateExtension,
      removeExtension,
      setExtensionEnabled,
      getProviders,
      getExtensions,
    };
  }, [
    config,
    blockedMutationKeys,
    providersList,
    extensionsList,
    extensionWarnings,
    upsert,
    read,
    remove,
    addExtension,
    updateExtension,
    removeExtension,
    setExtensionEnabled,
    getProviders,
    getExtensions,
  ]);

  return <ConfigContext.Provider value={contextValue}>{children}</ConfigContext.Provider>;
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};
