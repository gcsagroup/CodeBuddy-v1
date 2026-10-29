import { dialog, Menu, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { CodeEditorPreference } from '../utils/settings';

export interface CodeEditorSettings {
  get(): unknown;
  set(editor: CodeEditorPreference): void;
  t?(english: string, simplifiedChinese: string, traditionalChinese: string): string;
}

const kinds = new Set(['vscode', 'sublime', 'notepad++', 'generic']);

async function available(editor: unknown): Promise<boolean> {
  if (!editor || typeof editor !== 'object') return false;
  const value = editor as CodeEditorPreference;
  if (
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0') ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    !kinds.has(value.kind)
  )
    return false;
  const stat = await fs.stat(value.path).catch(() => null);
  if (process.platform === 'darwin' && value.path.endsWith('.app')) return !!stat?.isDirectory();
  return !!stat?.isFile() && (process.platform !== 'win32' || /\.exe$/i.test(value.path));
}

function editorAt(
  file: string,
  label: string,
  kind: CodeEditorPreference['kind']
): CodeEditorPreference {
  return { path: file, label, kind };
}

export async function discoverCodeEditors(): Promise<CodeEditorPreference[]> {
  const candidates: CodeEditorPreference[] = [];
  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter((root): root is string => !!root);
    const apps: [string, string, string, CodeEditorPreference['kind']][] = [
      ['Microsoft VS Code', 'Code.exe', 'Visual Studio Code', 'vscode'],
      ['Microsoft VS Code Insiders', 'Code - Insiders.exe', 'VS Code Insiders', 'vscode'],
      ['cursor', 'Cursor.exe', 'Cursor', 'vscode'],
      ['VSCodium', 'VSCodium.exe', 'VSCodium', 'vscode'],
      ['Sublime Text', 'sublime_text.exe', 'Sublime Text', 'sublime'],
      ['Sublime Text 3', 'sublime_text.exe', 'Sublime Text 3', 'sublime'],
      ['Notepad++', 'notepad++.exe', 'Notepad++', 'notepad++'],
    ];
    for (const root of roots)
      for (const [folder, exe, label, kind] of apps)
        candidates.push(editorAt(path.join(root, folder, exe), label, kind));
    // PATH may contain an editor's bin folder even for a nonstandard install.
    // Resolve the executable itself; never run a .cmd shim through a shell.
    for (const root of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute))
      for (const [, exe, label, kind] of apps) {
        candidates.push(editorAt(path.join(root, exe), label, kind));
        if (path.basename(root).toLowerCase() === 'bin')
          candidates.push(editorAt(path.join(root, '..', exe), label, kind));
      }
  } else if (process.platform === 'darwin') {
    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')])
      for (const [name, kind] of [
        ['Visual Studio Code', 'vscode'],
        ['Cursor', 'vscode'],
        ['VSCodium', 'vscode'],
        ['Sublime Text', 'sublime'],
      ] as const)
        candidates.push(editorAt(path.join(root, `${name}.app`), name, kind));
  } else {
    for (const root of (process.env.PATH ?? '/usr/bin')
      .split(path.delimiter)
      .filter(path.isAbsolute))
      for (const [name, label, kind] of [
        ['code', 'Visual Studio Code', 'vscode'],
        ['codium', 'VSCodium', 'vscode'],
        ['cursor', 'Cursor', 'vscode'],
        ['subl', 'Sublime Text', 'sublime'],
        ['kate', 'Kate', 'generic'],
      ] as const)
        candidates.push(editorAt(path.join(root, name), label, kind));
  }
  const checked = await Promise.all(
    candidates.map(async (editor) => ((await available(editor)) ? editor : null))
  );
  return checked
    .filter((editor): editor is CodeEditorPreference => !!editor)
    .filter((editor, index, all) => all.findIndex((item) => item.path === editor.path) === index);
}

async function chooseEditor(
  win: BrowserWindow,
  settings: CodeEditorSettings
): Promise<CodeEditorPreference | null> {
  const t = settings.t ?? ((english: string) => english);
  const editors = await discoverCodeEditors();
  const current = settings.get();
  if (
    (await available(current)) &&
    !editors.some((item) => item.path === (current as CodeEditorPreference).path)
  )
    editors.unshift(current as CodeEditorPreference);
  const choice = await new Promise<CodeEditorPreference | 'browse' | null>((resolve) => {
    Menu.buildFromTemplate([
      {
        label: t(
          'Default code editor (remember choice)',
          '默认代码编辑器（选择后记住）',
          '預設程式碼編輯器（記住選擇）'
        ),
        enabled: false,
      },
      ...editors.map((editor) => ({
        label: editor.label,
        type: 'radio' as const,
        checked:
          !!current &&
          typeof current === 'object' &&
          (current as CodeEditorPreference).path === editor.path,
        click: () => resolve(editor),
      })),
      ...(!editors.length
        ? [
            {
              label: t('No code editor detected', '未检测到代码编辑器', '未偵測到程式碼編輯器'),
              enabled: false,
            },
          ]
        : []),
      { type: 'separator' as const },
      {
        label: t('Choose another editor…', '选择其他编辑器…', '選擇其他編輯器…'),
        click: () => resolve('browse'),
      },
      {
        label: t('Preview in right panel only', '仅在右侧预览', '僅在右側預覽'),
        click: () => resolve(null),
      },
    ]).popup({ window: win, callback: () => resolve(null) });
  });
  if (choice !== 'browse') return choice;
  const result = await dialog.showOpenDialog(win, {
    title: t('Choose default code editor', '选择默认代码编辑器', '選擇預設程式碼編輯器'),
    properties: ['openFile'],
    ...(process.platform === 'win32'
      ? { filters: [{ name: 'Application', extensions: ['exe'] }] }
      : {}),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  const name = path.basename(file).toLowerCase();
  const kind = [
    'code.exe',
    'code - insiders.exe',
    'cursor.exe',
    'vscodium.exe',
    'visual studio code.app',
    'cursor.app',
    'vscodium.app',
    'code',
    'codium',
    'cursor',
  ].includes(name)
    ? 'vscode'
    : ['sublime_text.exe', 'sublime text.app', 'subl'].includes(name)
      ? 'sublime'
      : name === 'notepad++.exe'
        ? 'notepad++'
        : 'generic';
  const editor = editorAt(file, path.basename(file).replace(/\.(exe|app)$/i, ''), kind);
  if (!(await available(editor)))
    throw new Error(
      t(
        'The selected editor is unavailable. Choose another editor.',
        '选择的编辑器不可用，请重新选择。',
        '選擇的編輯器無法使用，請重新選擇。'
      )
    );
  return editor;
}

export async function openCodeFile(
  win: BrowserWindow,
  file: string,
  line: number | undefined,
  choose: boolean,
  settings: CodeEditorSettings,
  validate: () => Promise<void>
): Promise<'opened' | 'preview'> {
  const stored = settings.get();
  const editor =
    !choose && (await available(stored))
      ? (stored as CodeEditorPreference)
      : await chooseEditor(win, settings);
  if (!editor) return 'preview';
  // Re-check the owner and file after native menus/dialogs; never open a stale target.
  await validate();
  const location = Number.isSafeInteger(line) && line! > 0 ? line : undefined;
  const args =
    editor.kind === 'vscode'
      ? ['--reuse-window', ...(location ? ['--goto', `${file}:${location}`] : [file])]
      : editor.kind === 'sublime'
        ? [location ? `${file}:${location}` : file]
        : editor.kind === 'notepad++'
          ? [...(location ? [`-n${location}`] : []), file]
          : [file];
  const appBundle = process.platform === 'darwin' && editor.path.endsWith('.app');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      appBundle ? '/usr/bin/open' : editor.path,
      appBundle ? ['-a', editor.path, '--args', ...args] : args,
      // This is an interactive editor, not a background helper. Hiding its first
      // window also leaves later --reuse-window requests targeting a hidden app.
      { shell: false, windowsHide: false, detached: true, stdio: 'ignore' }
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  if (editor !== stored) settings.set(editor);
  return 'opened';
}
