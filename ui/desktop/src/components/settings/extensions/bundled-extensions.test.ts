import { describe, it, expect, vi } from 'vitest';
import {
  isConfigurableBundledExtension,
  pruneDeprecatedBundledExtensions,
  syncBundledExtensions,
} from './bundled-extensions';
import type { FixedExtensionEntry } from '../../ConfigContext';

vi.mock('./bundled-extensions.json', () => ({
  default: [
    {
      id: 'developer',
      name: 'developer',
      display_name: 'Developer',
      description: 'General development tools.',
      enabled: true,
      type: 'builtin',
      timeout: 300,
    },
    {
      id: 'googledrive',
      name: 'googledrive',
      display_name: 'Google Drive',
      description: 'Google Drive integration.',
      enabled: true,
      type: 'stdio',
      cmd: 'googledrive-mcp',
      args: [],
      env_keys: [],
      timeout: 300,
    },
    {
      id: 'tavily',
      name: 'tavily',
      description: 'Web search and extraction.',
      enabled: false,
      type: 'stdio',
      cmd: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env_keys: ['TAVILY_API_KEY'],
      available_tools: ['tavily_search', 'tavily_extract'],
      read_only_tools: ['tavily_search', 'tavily_extract'],
      timeout: 300,
      allow_configure: true,
      preserve_existing: true,
    },
  ],
}));

vi.mock('./deprecated-bundled-extensions.json', () => ({
  default: [{ id: 'googledrive' }, { id: 'old-bundled-extension' }],
}));

describe('syncBundledExtensions', () => {
  it('skips already bundled non-deprecated extensions', async () => {
    const addExtensionFn = vi.fn().mockResolvedValue(undefined);
    const existingExtensions = [
      {
        name: 'developer',
        type: 'builtin',
        description: 'Developer tools',
        enabled: true,
        bundled: true,
        timeout: 300,
      },
    ] as FixedExtensionEntry[];

    await syncBundledExtensions(existingExtensions, addExtensionFn);

    expect(addExtensionFn).not.toHaveBeenCalledWith(
      'developer',
      expect.anything(),
      expect.anything()
    );
  });

  it('adds Tavily disabled with its secret key and phase-one tool allowlist', async () => {
    const addExtensionFn = vi.fn().mockResolvedValue(undefined);

    await syncBundledExtensions([], addExtensionFn);

    expect(addExtensionFn).toHaveBeenCalledWith(
      'tavily',
      expect.objectContaining({
        type: 'stdio',
        cmd: 'npx',
        args: ['-y', 'tavily-mcp@latest'],
        env_keys: ['TAVILY_API_KEY'],
        available_tools: ['tavily_search', 'tavily_extract'],
        read_only_tools: ['tavily_search', 'tavily_extract'],
        bundled: true,
      }),
      false
    );
  });

  it('marks only explicitly configurable bundled extensions as configurable', () => {
    expect(
      isConfigurableBundledExtension({
        name: 'tavily',
        type: 'stdio',
        cmd: 'npx',
        args: [],
        enabled: false,
        bundled: true,
      } as FixedExtensionEntry)
    ).toBe(true);
    expect(
      isConfigurableBundledExtension({
        name: 'developer',
        type: 'builtin',
        enabled: true,
        bundled: true,
      } as FixedExtensionEntry)
    ).toBe(false);
  });

  it.each([false, true])('does not trust a custom Tavily command (bundled=%s)', async (bundled) => {
    const addExtensionFn = vi.fn().mockResolvedValue(undefined);
    const existingExtensions = [
      {
        name: 'tavily',
        type: 'stdio',
        description: 'My existing Tavily setup',
        cmd: 'custom-tavily-command',
        args: [],
        env_keys: ['MY_TAVILY_KEY'],
        enabled: true,
        bundled,
      },
    ] as FixedExtensionEntry[];

    await syncBundledExtensions(existingExtensions, addExtensionFn);

    expect(addExtensionFn).not.toHaveBeenCalledWith('tavily', expect.anything(), expect.anything());
  });

  it('adds managed read-only metadata to an existing bundled Tavily configuration', async () => {
    const addExtensionFn = vi.fn().mockResolvedValue(undefined);
    const existingExtensions = [
      {
        name: 'tavily',
        type: 'stdio',
        description: 'Existing bundled Tavily setup',
        cmd: 'npx',
        args: ['-y', 'tavily-mcp@latest'],
        env_keys: ['TAVILY_API_KEY'],
        enabled: true,
        bundled: true,
        available_tools: ['tavily_search', 'tavily_extract'],
      },
    ] as FixedExtensionEntry[];

    await syncBundledExtensions(existingExtensions, addExtensionFn);

    expect(addExtensionFn).toHaveBeenCalledWith(
      'tavily',
      expect.objectContaining({
        cmd: 'npx',
        env_keys: ['TAVILY_API_KEY'],
        read_only_tools: ['tavily_search', 'tavily_extract'],
      }),
      true
    );
  });
});

describe('pruneDeprecatedBundledExtensions', () => {
  it('removes deprecated bundled extensions', async () => {
    const removeExtensionFn = vi.fn().mockResolvedValue(undefined);
    const existingExtensions = [
      {
        name: 'old-bundled-extension',
        type: 'builtin',
        description: 'Old bundled extension',
        enabled: true,
        bundled: true,
      },
    ] as FixedExtensionEntry[];

    const remainingExtensions = await pruneDeprecatedBundledExtensions(
      existingExtensions,
      removeExtensionFn
    );

    expect(removeExtensionFn).toHaveBeenCalledWith('old-bundled-extension');
    expect(remainingExtensions).toEqual([]);
  });

  it('does not remove non-bundled deprecated extensions', async () => {
    const removeExtensionFn = vi.fn().mockResolvedValue(undefined);
    const existingExtensions = [
      {
        name: 'old-bundled-extension',
        type: 'builtin',
        description: 'Old bundled extension',
        enabled: true,
        bundled: false,
      },
    ] as FixedExtensionEntry[];

    const remainingExtensions = await pruneDeprecatedBundledExtensions(
      existingExtensions,
      removeExtensionFn
    );

    expect(removeExtensionFn).not.toHaveBeenCalled();
    expect(remainingExtensions).toEqual(existingExtensions);
  });

  it('allows same-id bundled extensions to be re-added after prune', async () => {
    const removeExtensionFn = vi.fn().mockResolvedValue(undefined);
    const addExtensionFn = vi.fn().mockResolvedValue(undefined);
    const existingExtensions = [
      {
        name: 'Google Drive',
        type: 'stdio',
        description: 'Google Drive extension',
        cmd: 'some-cmd',
        args: [],
        env_keys: [],
        enabled: true,
        bundled: true,
      },
    ] as FixedExtensionEntry[];

    const remainingExtensions = await pruneDeprecatedBundledExtensions(
      existingExtensions,
      removeExtensionFn
    );

    await syncBundledExtensions(remainingExtensions, addExtensionFn);

    expect(removeExtensionFn).toHaveBeenCalledWith('googledrive');
    expect(addExtensionFn).toHaveBeenCalledWith(
      'googledrive',
      expect.objectContaining({
        type: 'stdio',
        name: 'googledrive',
        bundled: true,
      }),
      true
    );
  });
});
