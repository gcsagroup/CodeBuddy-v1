import { describe, expect, it, vi } from 'vitest';
import {
  consolidateGitExtensions,
  pruneDeprecatedBundledExtensions,
  syncBundledExtensions,
} from './bundled-extensions';
import type { FixedExtensionEntry } from '../../ConfigContext';

describe('single memory capability migration', () => {
  it('removes the legacy bundled entry, retaining project memory and unrelated extensions', async () => {
    const entries = [
      { name: 'memory', type: 'builtin', bundled: true, enabled: true },
      { name: 'projectmemory', type: 'platform', bundled: true, enabled: true },
      {
        name: 'tavily',
        type: 'stdio',
        bundled: true,
        enabled: true,
        cmd: 'npx',
        args: ['-y', 'tavily-mcp@latest'],
      },
    ] as FixedExtensionEntry[];
    const remove = vi.fn().mockResolvedValue(undefined);
    const remaining = await pruneDeprecatedBundledExtensions(entries, remove);
    expect(remove).toHaveBeenCalledExactlyOnceWith('memory');
    expect(remaining.map((e) => e.name)).toEqual(['projectmemory', 'tavily']);
    const add = vi.fn().mockResolvedValue(undefined);
    await syncBundledExtensions(remaining, add);
    expect(add.mock.calls.some(([name]) => name === 'memory')).toBe(false);
  });
  it('does not remove a user-managed extension with the same name', async () => {
    const custom = {
      name: 'memory',
      type: 'stdio',
      cmd: 'custom-memory',
      args: [],
      enabled: true,
    } as FixedExtensionEntry;
    const remove = vi.fn();
    expect(await pruneDeprecatedBundledExtensions([custom], remove)).toEqual([custom]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('one Git executor', () => {
  it('disables platform Git when full external Git is configured', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined);
    await consolidateGitExtensions(
      [
        { name: 'git', type: 'platform', enabled: true },
        { name: 'local_git', type: 'stdio', cmd: 'node', args: [], enabled: true },
      ] as FixedExtensionEntry[],
      setEnabled
    );
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('git', false);
  });
  it('keeps platform Git when no external Git is configured', async () => {
    const setEnabled = vi.fn();
    await consolidateGitExtensions(
      [{ name: 'git', type: 'platform', enabled: true }] as FixedExtensionEntry[],
      setEnabled
    );
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

it('offers GitHub separately from local Git and preserves existing authenticated settings', async () => {
  const add = vi.fn().mockResolvedValue(undefined);
  await syncBundledExtensions([], add);
  const github = add.mock.calls.find(([name]) => name === 'github_official');
  expect(github).toBeDefined();
  expect(github![1]).toMatchObject({
    type: 'streamable_http',
    uri: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ${CODEBUDDY_GITHUB_MCP_TOKEN}' },
    env_keys: ['CODEBUDDY_GITHUB_MCP_TOKEN'],
  });
  expect(github![2]).toBe(false);
  add.mockClear();
  await syncBundledExtensions([{ ...github![1], enabled: true }] as FixedExtensionEntry[], add);
  expect(add.mock.calls.some(([name]) => name === 'github_official')).toBe(false);
});
