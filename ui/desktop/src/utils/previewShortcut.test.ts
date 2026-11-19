import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { previewToastActivator, registerPreviewShortcut } from './previewShortcut';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each([true, false])('migrates an Electron shortcut only when the preview owns it (%s)', (owned) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-shortcut-'));
  roots.push(root);
  const desktop = path.join(root, 'ui/desktop');
  const programs = path.join(root, 'Microsoft/Windows/Start Menu/Programs');
  fs.mkdirSync(path.join(desktop, 'src/images'), { recursive: true });
  fs.mkdirSync(programs, { recursive: true });
  const old = path.join(programs, 'Electron.lnk');
  const target = path.join(programs, 'CodeBuddy Preview/CodeBuddy.lnk');
  for (const file of [old, path.join(root, 'start-preview.ps1'), path.join(desktop, 'src/images/icon.ico')])
    fs.writeFileSync(file, '');
  const shell = {
    readShortcutLink: () => ({ target: 'electron.exe', appUserModelId: owned ? 'local.codebuddy.harness.preview' : 'other' }),
    writeShortcutLink: vi.fn(() => true),
  };
  registerPreviewShortcut(shell, root, desktop, 'electron.exe');
  expect(fs.existsSync(old)).toBe(!owned);
  expect(shell.writeShortcutLink).toHaveBeenCalledWith(target, owned ? 'update' : 'create',
    expect.objectContaining({ appUserModelId: 'local.codebuddy.harness.preview', toastActivatorClsid: previewToastActivator, icon: path.join(desktop, 'src/images/icon.ico') }));
  if (owned) {
    fs.writeFileSync(old, 'recreated by the native notification presenter');
    expect(registerPreviewShortcut(shell, root, desktop, 'electron.exe')).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toContain('recreated');
  }
});
