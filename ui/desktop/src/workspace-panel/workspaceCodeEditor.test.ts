import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCodeFile, type CodeEditorSettings } from './workspaceCodeEditor';
import type { CodeEditorPreference } from '../utils/settings';

const hooks = vi.hoisted(() => ({ stat: vi.fn(), menu: vi.fn(), choose: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ default: { stat: hooks.stat } }));
vi.mock('node:child_process', () => ({ spawn: hooks.spawn, default: { spawn: hooks.spawn } }));
vi.mock('electron', () => ({
  dialog: { showOpenDialog: hooks.choose },
  Menu: { buildFromTemplate: hooks.menu },
}));
const win = {} as BrowserWindow;
const editor: CodeEditorPreference = {
  path: path.join(os.tmpdir(), 'Code.exe'),
  label: 'VS Code',
  kind: 'vscode',
};
let files: Set<string>;
type Item = { label: string; enabled?: boolean; click?: () => void };
let menu: Item[];
let pick: (items: Item[]) => void;

beforeEach(() => {
  vi.resetAllMocks();
  files = new Set([editor.path]);
  menu = [];
  pick = () => {};
  hooks.stat.mockImplementation(async (file: string) => {
    if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isFile: () => !file.endsWith('.app'), isDirectory: () => file.endsWith('.app') };
  });
  hooks.menu.mockImplementation((items: Item[]) => {
    menu = items;
    return {
      popup: ({ callback }: { callback: () => void }) => {
        pick(items);
        callback();
      },
    };
  });
  hooks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    globalThis.queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});
afterEach(() => vi.unstubAllEnvs());

function settings(value: unknown = editor) {
  let saved = JSON.stringify(value);
  const set = vi.fn((next: CodeEditorPreference) => {
    saved = JSON.stringify(next);
  });
  return { get: () => JSON.parse(saved), set } satisfies CodeEditorSettings;
}

it('opens ts, tsx and scripts with the saved editor and real argument boundaries, without a protocol', async () => {
  const prefs = settings();
  const validate = vi.fn().mockResolvedValue(undefined);
  for (const extension of ['ts', 'tsx', 'py']) {
    const file = path.join(os.tmpdir(), `中文 #1 &file.${extension}`);
    expect(await openCodeFile(win, file, 170, false, prefs, validate)).toBe('opened');
    expect(hooks.spawn).toHaveBeenLastCalledWith(
      editor.path,
      ['--reuse-window', '--goto', `${file}:170`],
      expect.objectContaining({ shell: false, windowsHide: false, detached: true })
    );
  }
  expect(validate).toHaveBeenCalledTimes(3);
  expect(hooks.menu).not.toHaveBeenCalled();
  expect(prefs.set).not.toHaveBeenCalled();
});

it('detects an installed editor, remembers the explicit choice and reuses it on subsequent opens', async () => {
  vi.stubEnv('LOCALAPPDATA', path.join(os.tmpdir(), 'editor-detection'));
  vi.stubEnv('PATH', path.join(os.tmpdir(), 'editor-detection'));
  const detected =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA!, 'Programs', 'Microsoft VS Code', 'Code.exe')
      : process.platform === 'darwin'
        ? '/Applications/Visual Studio Code.app'
        : path.join(process.env.PATH!, 'code');
  files = new Set([detected]);
  pick = (items) => items.find((item) => item.label === 'Visual Studio Code')!.click!();
  const prefs = settings(null);
  const file = path.join(os.tmpdir(), 'app.ts');
  await openCodeFile(win, file, undefined, false, prefs, async () => {});
  expect(prefs.set).toHaveBeenCalledOnce();
  expect(prefs.get()).toEqual({ path: detected, label: 'Visual Studio Code', kind: 'vscode' });
  await openCodeFile(win, file, undefined, false, prefs, async () => {});
  expect(hooks.menu).toHaveBeenCalledOnce();
  expect(hooks.spawn).toHaveBeenCalledTimes(2);
  expect(prefs.set).toHaveBeenCalledOnce();
});

it('falls back to preview when no editor is available or selection is cancelled', async () => {
  files.clear();
  const prefs = settings({ ...editor, path: path.join(os.tmpdir(), 'removed.exe') });
  expect(await openCodeFile(win, 'file.ts', 1, false, prefs, async () => {})).toBe('preview');
  expect(menu.find((item) => item.label === 'No code editor detected')?.enabled).toBe(false);
  expect(hooks.spawn).not.toHaveBeenCalled();
  expect(prefs.set).not.toHaveBeenCalled();
});

it('changes the global editor only after an explicit choice and successful launch', async () => {
  const custom = path.join(os.tmpdir(), 'my-editor.exe');
  files.add(custom);
  pick = (items) => items.find((item) => item.label === 'Choose another editor…')!.click!();
  hooks.choose.mockResolvedValue({ canceled: false, filePaths: [custom] });
  const prefs = settings();
  await openCodeFile(win, 'source.ts', 90, true, prefs, async () => {});
  expect(hooks.spawn).toHaveBeenLastCalledWith(
    custom,
    ['source.ts'],
    expect.objectContaining({ shell: false, windowsHide: false, detached: true })
  );
  expect(prefs.get()).toEqual({ path: custom, label: 'my-editor', kind: 'generic' });
});

it('does not launch or remember a choice after the target session changes', async () => {
  pick = (items) => items.find((item) => item.label === 'VS Code')!.click!();
  const prefs = settings();
  await expect(
    openCodeFile(win, 'source.ts', 90, true, prefs, async () => {
      throw new Error('Conversation changed');
    })
  ).rejects.toThrow('Conversation changed');
  expect(hooks.spawn).not.toHaveBeenCalled();
  expect(prefs.set).not.toHaveBeenCalled();
});

it('reports a launch failure without switching to a system file association', async () => {
  hooks.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    globalThis.queueMicrotask(() => child.emit('error', new Error('Editor unavailable')));
    return child;
  });
  const prefs = settings();
  await expect(
    openCodeFile(win, 'source.ts', undefined, false, prefs, async () => {})
  ).rejects.toThrow('Editor unavailable');
  expect(prefs.set).not.toHaveBeenCalled();
  expect(hooks.spawn).toHaveBeenCalledOnce();
});
