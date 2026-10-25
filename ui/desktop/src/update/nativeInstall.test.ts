import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { app, autoUpdater } from 'electron';
import { MacUpdateInstaller, previousInstallError } from './nativeInstall';
import type { UpdateCandidate } from './githubRelease';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: new EventEmitter(),
    autoUpdater: Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    }),
  };
});
afterEach(() => {
  (autoUpdater as unknown as EventEmitter).removeAllListeners();
  vi.clearAllMocks();
});

it('Mac feed exposes only verified local bytes and only becomes installable after the native receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac-update-feed-'));
  const file = path.join(root, 'CodeBuddy.zip');
  const bytes = Buffer.from('fixture zip bytes');
  await writeFile(file, bytes);
  const candidate = {
    version: '1.43.11',
    notes: '升级',
    artifact: { size: bytes.length },
  } as UpdateCandidate;
  const installer = new MacUpdateInstaller();
  try {
    await expect(installer.install()).rejects.toThrow('尚未');
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {
      void (async () => {
        const calls = vi.mocked(autoUpdater.setFeedURL).mock.calls;
        const { url } = calls[calls.length - 1][0];
        const feed = await (await fetch(url)).json();
        expect(new URL(url).hostname).toBe('127.0.0.1');
        expect((await fetch(new URL('/unrelated', url))).status).toBe(404);
        expect((await fetch(url, { method: 'POST' })).status).toBe(405);
        expect(Buffer.from(await (await fetch(feed.url)).arrayBuffer())).toEqual(bytes);
        autoUpdater.emit('update-downloaded');
      })().catch((error) => autoUpdater.emit('error', error));
    });
    await installer.stage(candidate, file, new AbortController().signal);
    vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
      app.emit('before-quit');
    });
    await installer.install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    expect(autoUpdater.listenerCount('error')).toBe(0);
    vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
      globalThis.queueMicrotask(() => autoUpdater.emit('error', new Error('fixture failure')));
    });
    await expect(installer.install()).rejects.toThrow('启动失败');
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {});
    const cancel = new AbortController();
    const preparing = installer.stage(candidate, file, cancel.signal);
    cancel.abort();
    await expect(preparing).rejects.toThrow('取消');
    await expect(installer.install()).rejects.toThrow('尚未');
    expect(autoUpdater.listenerCount('update-downloaded')).toBe(0);
  } finally {
    installer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('a failed installer is reported after restart, without exposing command details or stale success', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-receipt-'));
  const file = path.join(root, 'last-install-result.json');
  try {
    await writeFile(
      file,
      '\ufeff' + JSON.stringify({ status: 'failed', version: '1.43.11', detail: 'private path' })
    );
    expect(previousInstallError(root, '1.43.10')).toContain('上次');
    expect(previousInstallError(root, '1.43.10')).not.toContain('private path');
    expect(previousInstallError(root, '1.43.11')).toBeUndefined();
    await writeFile(file, JSON.stringify({ status: 'installed', version: '1.43.11' }));
    expect(previousInstallError(root, '1.43.10')).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
