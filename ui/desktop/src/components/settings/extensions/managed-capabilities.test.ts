import { describe, expect, it, vi } from 'vitest';
import { enableManagedCapabilities, isManagedCapability } from './managed-capabilities';
import { buildToolboxModel } from '../../toolbox/toolboxModel';
import type { ConfiguredExtensionEntry } from '../../../acp/extensions';

const entries: ConfiguredExtensionEntry[] = [
  ...['tom', 'code_execution', 'summarize', 'todo', 'apps'].map((name) => ({
    type: 'platform' as const,
    name,
    enabled: false,
  })),
  { type: 'builtin', name: 'autovisualiser', enabled: false },
];
describe('managed desktop capabilities', () => {
  it('installs all six defaults on an empty profile', async () => {
    const add = vi.fn();
    const enable = vi.fn();
    await enableManagedCapabilities([], enable, add);
    expect(add.mock.calls.map(([entry, enabled]) => [entry.name, enabled])).toEqual(
      entries.map((entry) => [entry.name, true])
    );
    expect(enable).not.toHaveBeenCalled();
  });
  it('enables existing disabled entries, preserves external tools and is idempotent', async () => {
    const config: ConfiguredExtensionEntry[] = [
      ...entries.map((entry) => ({ ...entry })),
      { type: 'stdio', name: 'local_git', cmd: 'node', enabled: true },
      { type: 'platform', name: 'git', enabled: false },
      { type: 'platform', name: 'projectmemory', enabled: false },
      {
        type: 'stdio',
        name: 'todo',
        cmd: 'custom-server',
        configKey: 'custom_todo',
        enabled: false,
      },
    ];
    const enable = vi.fn(async (key: string, enabled: boolean) => {
      config.find((e) => (e.configKey ?? e.name) === key)!.enabled = enabled;
    });
    const add = vi.fn();
    await enableManagedCapabilities(config, enable, add);
    expect(enable.mock.calls).toEqual(entries.map((entry) => [entry.name, true]));
    enable.mockClear();
    await enableManagedCapabilities(config, enable, add);
    expect(enable).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    const model = buildToolboxModel({ skills: [], apps: [], extensions: config });
    expect(model.capabilities.map((item) => item.name)).toEqual(['projectmemory']);
    expect(model.external.map((item) => item.name).sort()).toEqual(['local_git', 'todo']);
  });
  it('matches stable keys and legacy codeexecution alias, not external names', () => {
    expect(
      isManagedCapability({ type: 'platform', name: 'Code mode', configKey: 'codeexecution' })
    ).toBe(true);
    expect(isManagedCapability({ type: 'stdio', name: 'todo' })).toBe(false);
  });
  it('propagates a persistence failure instead of claiming defaults were enabled', async () => {
    await expect(
      enableManagedCapabilities(
        entries,
        vi.fn().mockRejectedValue(new Error('write failed')),
        vi.fn()
      )
    ).rejects.toThrow('write failed');
  });
});
