import { app, dialog, Menu, nativeImage, type BrowserWindow } from 'electron';
import {
  queryWindowsAssociations,
  type WindowsFileAssociations,
} from './workspaceWindowsAssociations';
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
    if (process.env.SystemRoot)
      candidates.push(
        editorAt(
          path.join(process.env.SystemRoot, 'System32', 'notepad.exe'),
          '记事本 / Notepad',
          'generic'
        )
      );
    // PATH may contain an editor's bin folder even for a nonstandard install.
    // Resolve the executable itself; never run a .cmd shim through a shell.
    for (const root of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute))
      for (const [, exe, label, kind] of apps) {
        candidates.push(editorAt(path.join(root, exe), label, kind));
        if (path.basename(root).toLowerCase() === 'bin')
          candidates.push(editorAt(path.join(root, '..', exe), label, kind));
      }
  } else if (process.platform === 'darwin') {
    candidates.push(editorAt('/System/Applications/TextEdit.app', 'TextEdit', 'generic'));
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
  return browseApplication(win, settings);
}

async function browseApplication(win: BrowserWindow, settings: CodeEditorSettings) {
  const t = settings.t ?? ((english: string) => english);
  const result = await dialog.showOpenDialog(win, {
    title: t('Choose an application', '选择应用', '選擇應用程式'),
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
  await launchCodeEditor(editor, file, line);
  if (editor !== stored) settings.set(editor);
  return 'opened';
}

export async function launchCodeEditor(editor: CodeEditorPreference, file: string, line?: number) {
  if (!(await available(editor)))
    throw new Error('The selected application is no longer available');
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
}

export type TargetApplication =
  | CodeEditorPreference
  | { associationId: string }
  | 'default'
  | 'reveal'
  | 'system'
  | null;

export async function chooseTargetApplication(
  win: BrowserWindow,
  directory: boolean,
  textFile: boolean,
  settings: CodeEditorSettings,
  target?: { file: string; editorOnly: boolean }
): Promise<TargetApplication> {
  const t = settings.t ?? ((english: string) => english);
  const useAssociations =
    process.platform === 'win32' && !directory && target && !target.editorOnly;
  let associations: WindowsFileAssociations | undefined;
  let lookupFailed = false;
  if (useAssociations) {
    try {
      associations = await queryWindowsAssociations(target.file);
    } catch {
      lookupFailed = true;
    }
  }
  const editors = directory || textFile ? await discoverCodeEditors() : [];
  const current = settings.get();
  if (
    (directory || textFile) &&
    (await available(current)) &&
    !editors.some((item) => item.path === (current as CodeEditorPreference).path)
  )
    editors.unshift(current as CodeEditorPreference);
  const choices = editors.filter(
    (editor) =>
      (!directory || ['vscode', 'sublime'].includes(editor.kind)) &&
      !associations?.handlers.some(
        (handler) =>
          handler.id.toLowerCase() === editor.path.toLowerCase() || handler.label === editor.label
      )
  );
  const editorItems = await Promise.all(
    choices.map(async (editor) => ({
      label: editor.label,
      icon: await app.getFileIcon(editor.path, { size: 'small' }).catch(() => undefined),
      click: () => editor,
    }))
  );
  const selected = await new Promise<TargetApplication | 'browse'>((resolve) => {
    Menu.buildFromTemplate([
      {
        label: directory
          ? t('File manager (default)', '文件资源管理器（默认）', '檔案管理員（預設）')
          : target?.editorOnly
            ? t('Open in code editor', '用代码编辑器打开', '使用程式碼編輯器開啟')
            : associations?.defaultLabel
              ? `${associations.defaultLabel}${t(' (default)', '（默认）', '（預設）')}`
              : t('Default application', '系统默认应用', '系統預設應用程式'),
        click: () => resolve('default'),
      },
      ...(lookupFailed
        ? [
            {
              label: t(
                'System app list unavailable',
                '暂时无法读取系统应用列表',
                '暫時無法讀取系統應用程式清單'
              ),
              enabled: false,
            },
          ]
        : []),
      ...(associations?.handlers ?? [])
        .filter((handler) => handler.label !== associations?.defaultLabel)
        .map((handler) => ({
          label: handler.label,
          icon: handler.icon?.startsWith('data:image/png;base64,')
            ? nativeImage.createFromDataURL(handler.icon)
            : undefined,
          click: () => resolve({ associationId: handler.id }),
        })),
      ...(associations?.handlers.length && editorItems.length
        ? [{ type: 'separator' as const }]
        : []),
      ...editorItems.map((item, index) => ({ ...item, click: () => resolve(choices[index]) })),
      ...(!directory
        ? [
            {
              label: t('Choose another application…', '选择其他应用…', '選擇其他應用程式…'),
              click: () => resolve(useAssociations ? 'system' : 'browse'),
            },
          ]
        : []),
      { type: 'separator' as const },
      {
        label: t('Show in folder', '显示文件位置', '顯示檔案位置'),
        click: () => resolve('reveal'),
      },
    ]).popup({ window: win, callback: () => resolve(null) });
  });
  return selected === 'browse' ? browseApplication(win, settings) : selected;
}
