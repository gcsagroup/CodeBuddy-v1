import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zGooseExtension } from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import {
  extensionConfigToGooseExtension,
  gooseExtensionToExtensionConfig,
  testConfigExtension,
  updateConfigExtension,
} from './extensions';

vi.mock('./acpConnection', () => ({ getAcpClient: vi.fn() }));

describe('updateConfigExtension', () => {
  it.each([
    { type: 'stdio' as const, cmd: 'server' },
    { type: 'streamable_http' as const, uri: 'https://example.com/mcp' },
  ])('preserves read-only tools through SDK validation and $type save/read', (transport) => {
    const config = {
      ...transport,
      name: 'search',
      read_only_tools: ['search'],
      env_keys: ['API_KEY'],
    };
    const wire = extensionConfigToGooseExtension(config)!;
    const decoded = zGooseExtension.parse(JSON.parse(JSON.stringify(wire)));
    expect(gooseExtensionToExtensionConfig(decoded)).toEqual(expect.objectContaining(config));
  });
  beforeEach(() => vi.clearAllMocks());

  it('uses the atomic update request instead of remove then add', async () => {
    const update = vi.fn().mockResolvedValue({});
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { configExtensionsUpdate_unstable: update },
    } as never);

    await updateConfigExtension(
      'old-key',
      { type: 'stdio', name: 'new name', description: '', cmd: 'server' },
      true
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ configKey: 'old-key', enabled: true })
    );
  });

  it('tests a candidate without calling persistence methods', async () => {
    const test = vi.fn().mockResolvedValue({ success: true, tools: [], resourceCount: 0 });
    const add = vi.fn();
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        configExtensionsTest_unstable: test,
        configExtensionsAdd_unstable: add,
      },
    } as never);

    await testConfigExtension(
      { type: 'stdio', name: 'candidate', description: '', cmd: 'server' },
      { TOKEN: 'temporary' },
      'D:\\project'
    );

    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({ environment: { TOKEN: 'temporary' }, workingDir: 'D:\\project' })
    );
    expect(add).not.toHaveBeenCalled();
  });
});
