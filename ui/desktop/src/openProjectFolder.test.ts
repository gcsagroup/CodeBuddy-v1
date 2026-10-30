import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProjectFolderInWindow } from './openProjectFolder';

describe('open a project in the originating window', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    root = await mkdtemp(join(tmpdir(), 'codebuddy-folder-'));
    const directory = join(root, '中文 [1] & project');
    await mkdir(directory);
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      show: vi.fn(),
      focus: vi.fn(),
    };
    return { directory, window, target: window as unknown as BrowserWindow };
  }
  it('trusts the exact folder and stages a draft in the same window', async () => {
    const { directory, window, target } = await fixture();
    const confirm = vi.fn(async () => true);
    const canonical = await realpath(directory);
    expect(await openProjectFolderInWindow(target, directory, confirm)).toBe(canonical);
    expect(confirm).toHaveBeenCalledWith(canonical);
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('new-chat', canonical);
    expect(window.focus).toHaveBeenCalledOnce();
  });
  it('leaves the current page untouched when trust is cancelled', async () => {
    const { directory, window, target } = await fixture();
    expect(await openProjectFolderInWindow(target, directory, async () => false)).toBeUndefined();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
  it('does not redirect another window if the originating window closes during confirmation', async () => {
    const { directory, window, target } = await fixture();
    await openProjectFolderInWindow(target, directory, async () => {
      window.isDestroyed.mockReturnValue(true);
      return true;
    });
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
  it('rejects missing paths and files instead of silently opening the parent folder', async () => {
    const { directory, window, target } = await fixture();
    const confirm = vi.fn(async () => true);
    await expect(
      openProjectFolderInWindow(target, join(directory, 'missing'), confirm)
    ).rejects.toThrow();
    const file = join(directory, 'file.txt');
    await writeFile(file, 'fixture');
    await expect(openProjectFolderInWindow(target, file, confirm)).rejects.toThrow(
      'existing folder'
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
