import type { ConfiguredExtensionEntry } from '../../../acp/extensions';
import type { ExtensionConfig } from '../../../types/extensions';

// These capabilities are part of the desktop defaults, without toolbox switches.
const DEFAULT_CAPABILITIES: ExtensionConfig[] = [
  ...['tom', 'code_execution', 'summarize', 'todo', 'apps'].map((name) => ({
    type: 'platform' as const,
    name,
  })),
  { type: 'builtin', name: 'autovisualiser', timeout: 300, bundled: true },
];

export function isManagedCapability(
  extension: Pick<ConfiguredExtensionEntry, 'type' | 'name' | 'configKey'>
): boolean {
  const key = (extension.configKey ?? extension.name).toLowerCase();
  const name = key === 'codeexecution' ? 'code_execution' : key;
  return DEFAULT_CAPABILITIES.some((entry) => entry.type === extension.type && entry.name === name);
}

export async function enableManagedCapabilities(
  extensions: ConfiguredExtensionEntry[],
  setEnabled: (key: string, enabled: boolean) => Promise<void>,
  add: (config: ExtensionConfig, enabled: boolean) => Promise<void>
): Promise<void> {
  for (const defaults of DEFAULT_CAPABILITIES) {
    const existing = extensions.find(
      (entry) =>
        entry.type === defaults.type &&
        ((entry.configKey ?? entry.name) === defaults.name ||
          (defaults.name === 'code_execution' &&
            (entry.configKey ?? entry.name) === 'codeexecution'))
    );
    if (existing) {
      if (!existing.enabled) await setEnabled(existing.configKey ?? existing.name, true);
    } else {
      // Preserve a user-managed extension occupying the same configuration key.
      if (extensions.some((entry) => (entry.configKey ?? entry.name) === defaults.name)) continue;
      await add(defaults, true);
    }
  }
}
