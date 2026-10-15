import type { ExtensionConfig } from '../../../types/extensions';
import { FixedExtensionEntry } from '../../ConfigContext';
import bundledExtensionsData from './bundled-extensions.json';
import deprecatedBundledExtensionsData from './deprecated-bundled-extensions.json';
import { nameToKey } from './utils';

// Type definition for built-in extensions from JSON
type BundledExtension = {
  id: string;
  name: string;
  display_name?: string;
  description: string;
  enabled: boolean;
  type: 'builtin' | 'stdio' | 'streamable_http';
  cmd?: string;
  args?: string[];
  uri?: string;
  headers?: Record<string, string>;
  envs?: { [key: string]: string };
  env_keys?: Array<string>;
  available_tools?: string[];
  read_only_tools?: string[];
  timeout?: number;
  allow_configure?: boolean;
  preserve_existing?: boolean;
};

type DeprecatedBundledExtension = {
  id: string;
};

export function getDeprecatedBundledExtensions(): DeprecatedBundledExtension[] {
  return deprecatedBundledExtensionsData as DeprecatedBundledExtension[];
}

function isBundledExtension(extension: FixedExtensionEntry): boolean {
  return 'bundled' in extension && extension.bundled === true;
}

export function isConfigurableBundledExtension(extension: FixedExtensionEntry): boolean {
  if (!isBundledExtension(extension)) return false;

  const extensionId = nameToKey(extension.name);
  return (bundledExtensionsData as BundledExtension[]).some(
    (bundledExtension) =>
      bundledExtension.id === extensionId && bundledExtension.allow_configure === true
  );
}

export async function pruneDeprecatedBundledExtensions(
  existingExtensions: FixedExtensionEntry[],
  removeExtensionFn: (id: string) => Promise<void>
): Promise<FixedExtensionEntry[]> {
  const deprecatedExtensionIds = new Set(getDeprecatedBundledExtensions().map((ext) => ext.id));
  const remainingExtensions: FixedExtensionEntry[] = [];

  for (const existingExt of existingExtensions) {
    if (!isBundledExtension(existingExt)) {
      remainingExtensions.push(existingExt);
      continue;
    }

    if (!deprecatedExtensionIds.has(nameToKey(existingExt.name))) {
      remainingExtensions.push(existingExt);
      continue;
    }

    await removeExtensionFn(nameToKey(existingExt.name));
  }

  return remainingExtensions;
}

/**
 * Synchronizes built-in extensions with the config system.
 * This function ensures all built-in extensions are added, which is especially
 * important for first-time users with an empty config.yaml.
 *
 * @param existingExtensions Current list of extensions from the config (could be empty)
 * @param addExtensionFn Function to add a new extension to the config
 * @returns Promise that resolves when sync is complete
 */
export async function syncBundledExtensions(
  existingExtensions: FixedExtensionEntry[],
  addExtensionFn: (name: string, config: ExtensionConfig, enabled: boolean) => Promise<void>
): Promise<void> {
  try {
    // Cast the imported JSON data to the expected type
    const bundledExtensions = bundledExtensionsData as BundledExtension[];

    // Process each bundled extension
    for (const bundledExt of bundledExtensions) {
      // Find if this extension already exists
      const existingExt = existingExtensions.find((ext) => nameToKey(ext.name) === bundledExt.id);

      const currentReadOnlyTools =
        existingExt && 'read_only_tools' in existingExt ? existingExt.read_only_tools : undefined;
      const shouldUpdateManagedMetadata =
        existingExt !== undefined &&
        isBundledExtension(existingExt) &&
        ((existingExt.type === 'stdio' &&
          bundledExt.type === 'stdio' &&
          existingExt.cmd === bundledExt.cmd &&
          JSON.stringify(existingExt.args ?? []) === JSON.stringify(bundledExt.args ?? [])) ||
          (existingExt.type === 'streamable_http' &&
            bundledExt.type === 'streamable_http' &&
            existingExt.uri === bundledExt.uri)) &&
        bundledExt.read_only_tools !== undefined &&
        JSON.stringify(currentReadOnlyTools ?? []) !== JSON.stringify(bundledExt.read_only_tools);

      if (existingExt && shouldUpdateManagedMetadata) {
        const { enabled, configKey: _configKey, ...existingConfig } = existingExt;
        await addExtensionFn(
          bundledExt.name,
          {
            ...existingConfig,
            read_only_tools: bundledExt.read_only_tools,
          } as ExtensionConfig,
          enabled
        );
        continue;
      }

      if (
        existingExt &&
        (isBundledExtension(existingExt) || bundledExt.preserve_existing === true)
      ) {
        continue;
      }

      // Create the config for this extension
      let extConfig: ExtensionConfig;
      switch (bundledExt.type) {
        case 'builtin':
          extConfig = {
            type: bundledExt.type,
            name: bundledExt.name,
            description: bundledExt.description,
            display_name: bundledExt.display_name,
            timeout: bundledExt.timeout ?? 300,
            bundled: true,
          };
          break;
        case 'stdio':
          extConfig = {
            type: bundledExt.type,
            name: bundledExt.name,
            description: bundledExt.description,
            timeout: bundledExt.timeout,
            cmd: bundledExt.cmd || '',
            args: bundledExt.args || [],
            envs: bundledExt.envs,
            env_keys: bundledExt.env_keys || [],
            bundled: true,
            available_tools: bundledExt.available_tools,
            read_only_tools: bundledExt.read_only_tools,
          };
          break;
        case 'streamable_http':
          extConfig = {
            type: bundledExt.type,
            name: bundledExt.name,
            description: bundledExt.description,
            timeout: bundledExt.timeout,
            uri: bundledExt.uri || '',
            headers: bundledExt.headers,
            env_keys: bundledExt.env_keys || [],
            bundled: true,
            available_tools: bundledExt.available_tools,
            read_only_tools: bundledExt.read_only_tools,
          };
      }

      // Add or update the extension, preserving enabled state if it exists
      const enabled = existingExt ? existingExt.enabled : bundledExt.enabled;
      await addExtensionFn(bundledExt.name, extConfig, enabled);
    }
  } catch (error) {
    console.error('Failed to sync built-in extensions:', error);
    throw error;
  }
}

/** Prefer the configured full Git MCP over the overlapping platform tools. */
export async function consolidateGitExtensions(
  extensions: FixedExtensionEntry[],
  setEnabled: (configKey: string, enabled: boolean) => Promise<void>
): Promise<void> {
  const external = extensions.find((e) => e.name === 'local_git' && e.type === 'stdio');
  if (!external) return;
  const builtin = extensions.find((e) => e.name === 'git' && e.type === 'platform' && e.enabled);
  if (builtin) await setEnabled(builtin.configKey ?? builtin.name, false);
}
