import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { app } from 'electron';
import { prepareWindowsInstall } from './nativeInstall';
import type { UpdateCandidate } from './githubRelease';

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, autoUpdater: {} }));

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.skipIf(process.platform !== 'win32')(
  'a real hidden Windows helper acknowledges startup and cancellation prevents installation',
  async () => {
    const prefix = path.join(os.tmpdir(), 'codebuddy-更新-helper-');
    const root = await mkdtemp(prefix);
    const installation = path.join(root, '已安装 app');
    const updates = path.join(root, '更新');
    const installer = path.join(root, 'never-run.exe');
    const installerBytes = 'A checksum fixture, never executed';
    await writeFile(installer, installerBytes);
    await mkdir(installation);
    await writeFile(path.join(installation, 'unins000.exe'), 'fixture');
    vi.mocked(app.getPath).mockReturnValue(path.join(installation, 'CodeBuddy.exe'));
    let cancel: (() => void) | undefined;
    let pid: number | undefined;
    try {
      const candidate = {
        version: '1.43.12',
        artifact: { sha256: createHash('sha256').update(installerBytes).digest('hex') },
      } as UpdateCandidate;
      const prepared = await prepareWindowsInstall(candidate, installer, updates);
      cancel = prepared.cancel;
      const attempt = path.join(updates, (await readdir(updates))[0]);
      const receipt = JSON.parse(
        (await readFile(path.join(attempt, 'helper-ready.json'), 'utf8')).replace(/^\uFEFF/, '')
      );
      pid = receipt.pid;
      expect(receipt.version).toBe('1.43.12');
      expect(alive(pid!)).toBe(true);
      await expect(access(path.join(attempt, 'ready'))).rejects.toThrow();
      prepared.cancel();
      const deadline = Date.now() + 5000;
      while (alive(pid!) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(pid!)).toBe(false);
      await expect(access(path.join(attempt, 'result.json'))).rejects.toThrow();
      await expect(access(path.join(attempt, 'armed.json'))).rejects.toThrow();
    } finally {
      cancel?.();
      expect(path.resolve(root).startsWith(path.resolve(prefix))).toBe(true);
      if (!pid || !alive(pid)) await rm(root, { recursive: true, force: true });
    }
  },
  30000
);

it.skipIf(process.platform !== 'win32')(
  'a checksum failure is detected before the running application can commit installation',
  async () => {
    const prefix = path.join(os.tmpdir(), 'codebuddy-checksum-helper-');
    const root = await mkdtemp(prefix);
    const installation = path.join(root, 'installed');
    const updates = path.join(root, 'updates');
    const installer = path.join(root, 'never-run.exe');
    await mkdir(installation);
    await writeFile(path.join(installation, 'unins000.exe'), 'fixture');
    await writeFile(installer, 'An intentionally mismatched installer');
    vi.mocked(app.getPath).mockReturnValue(path.join(installation, 'CodeBuddy.exe'));
    try {
      await expect(
        prepareWindowsInstall(
          { version: '1.43.13', artifact: { sha256: '0'.repeat(64) } } as UpdateCandidate,
          installer,
          updates
        )
      ).rejects.toThrow('更新助手未就绪');
      const attempt = path.join(updates, (await readdir(updates))[0]);
      const result = JSON.parse(
        (await readFile(path.join(attempt, 'result.json'), 'utf8')).replace(/^\uFEFF/, '')
      );
      expect(result.status).toBe('failed');
      expect(result.detail).toBe('Installer checksum mismatch');
      expect(alive(process.pid)).toBe(true);
      for (const file of ['helper-ready.json', 'ready', 'armed.json'])
        await expect(access(path.join(attempt, file))).rejects.toThrow();
    } finally {
      expect(path.resolve(root).startsWith(path.resolve(prefix))).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30000
);
