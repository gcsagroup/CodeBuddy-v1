import {
  app,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { openCodeFile, type CodeEditorSettings } from './workspaceCodeEditor';
import type { DocumentPreviewer } from '../../../../runtime/document-preview.mjs';
import { MEDIA_SCHEME, PanelMediaRegistry, mediaRange } from './workspacePanelMedia';
import type { IPty } from 'node-pty';
import { terminalModulePath, terminalShell } from './workspacePanelTerminal';
import { BrowserController } from './browserControl';
import { createWorkspacePreview } from './workspacePreview';
import type {
  PanelBrowserState,
  PanelReply,
  PanelRequest,
  PanelScope,
  PanelFileMenuChoice,
  WebLinkMenuRequest,
  WebLinkMenuChoice,
  PanelTabAction,
  PanelTabMenuRequest,
} from './workspacePanelTypes';
import {
  listPanelFiles,
  inspectPanelFile,
  externalPanelFile,
  canOpenPanelFileExternally,
  isPanelEditorFile,
  panelPath,
  panelMedia,
  panelMediaType,
  isPanelDocument,
  panelUrl,
  readPanelFile,
  readPanelReference,
  resolvePanelReference,
  savePanelFile,
  searchPanelFiles,
} from './workspacePanelFiles';

interface TerminalState {
  scope: string;
  pty: IPty;
  buffer: string;
  base: number;
  exited: boolean;
}
interface BrowserState {
  scope: string;
  view: WebContentsView;
  error?: string;
  controller: BrowserController;
  preview?: Awaited<ReturnType<typeof createWorkspacePreview>>;
  bounds?: { x: number; y: number; width: number; height: number } | null;
}
interface Owner {
  id: number;
  win: BrowserWindow;
  roots: Map<string, string>;
  terminals: Map<string, TerminalState>;
  browsers: Map<string, BrowserState>;
  documentPreviewer?: Promise<DocumentPreviewer>;
  documentRequests?: Map<string, { scope: string; controller: AbortController }>;
  repositionBrowsers?: () => void;
}
const owners = new Map<number, Owner>();
let updatePending = false;
let codeEditorSettings: CodeEditorSettings = { get: () => null, set: () => {} };
export function hasWorkspaceTerminals(): boolean {
  return [...owners.values()].some((owner) =>
    [...owner.terminals.values()].some((terminal) => !terminal.exited)
  );
}
export function reserveWorkspaceUpdate(): () => void {
  if (updatePending) throw new Error('应用正在准备更新。');
  updatePending = true;
  return () => {
    updatePending = false;
  };
}
const mediaFiles = new PanelMediaRegistry();
const mediaSessions = new WeakSet<Session>();
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

export function registerWorkspaceMediaSession(session: Session) {
  if (mediaSessions.has(session)) return;
  mediaSessions.add(session);
  session.protocol.handle(MEDIA_SCHEME, async (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    try {
      const media = await mediaFiles.resolve(request.url);
      const range = mediaRange(request.headers.get('Range'), media.size);
      const headers = new globalThis.Headers({
        'Content-Type': media.mimeType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      });
      if (range.status === 416) {
        headers.set('Content-Range', `bytes */${media.size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Length', String(range.length));
      if (range.status === 206)
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${media.size}`);
      if (request.method === 'HEAD') return new Response(null, { status: range.status, headers });
      const response = await net.fetch(media.url, {
        headers: range.status === 206 ? { Range: `bytes=${range.start}-${range.end}` } : {},
      });
      return new Response(response.body, { status: range.status, headers });
    } catch (error) {
      console.warn(
        'Workspace media preview failed:',
        error instanceof Error ? error.message : String(error)
      );
      return new Response(null, { status: 404 });
    }
  });
}

function dispose(owner: Owner) {
  if (owner.repositionBrowsers) {
    owner.win.removeListener('resize', owner.repositionBrowsers);
    owner.win.removeListener('restore', owner.repositionBrowsers);
  }
  mediaFiles.revoke(owner.id);
  for (const request of owner.documentRequests?.values() ?? []) request.controller.abort();
  void owner.documentPreviewer?.then((previewer) => previewer.dispose()).catch(console.warn);
  for (const terminal of owner.terminals.values()) {
    if (!terminal.exited) {
      try {
        terminal.pty.kill();
      } catch {
        /* Already exited. */
      }
    }
  }
  for (const browser of owner.browsers.values()) {
    browser.preview?.close();
    if (!browser.view.webContents.isDestroyed()) browser.view.webContents.close();
  }
  owner.terminals.clear();
  owner.browsers.clear();
  if (owners.get(owner.id) === owner) owners.delete(owner.id);
}

function ownerFor(event: IpcMainInvokeEvent): Owner {
  const win = BrowserWindow.fromWebContents(event.sender);
  // Guest websites have no preload and can never become owners of desktop IPC resources.
  if (!win || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame)
    throw new Error('Workspace panel requires the application main frame');
  let owner = owners.get(event.sender.id);
  if (!owner) {
    owner = {
      id: event.sender.id,
      win,
      roots: new Map(),
      terminals: new Map(),
      browsers: new Map(),
    };
    owners.set(event.sender.id, owner);
    registerWorkspaceMediaSession(event.sender.session);
    const current = owner;
    current.repositionBrowsers = () => {
      for (const browser of current.browsers.values()) positionBrowser(current, browser);
    };
    win.on('resize', current.repositionBrowsers);
    win.on('restore', current.repositionBrowsers);
    win.once('closed', () => dispose(current));
    win.webContents.on('render-process-gone', () => dispose(current));
    win.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) dispose(current);
    });
  }
  return owner;
}

function positionBrowser(owner: Owner, browser: BrowserState) {
  if (browser.view.webContents.isDestroyed() || owner.win.isDestroyed()) return;
  const b = browser.bounds;
  if (!b) {
    browser.view.setVisible(false);
    return;
  }
  // Windows reports the minimized window's tiny content size while the renderer
  // retains its previous layout. Keep that layout and reapply it on restore.
  if (owner.win.isMinimized()) return;
  const [w, h] = owner.win.getContentSize();
  const zoom = owner.win.webContents.getZoomFactor();
  const x = Math.max(0, Math.min(w, Math.round(b.x * zoom))),
    y = Math.max(0, Math.min(h, Math.round(b.y * zoom)));
  const width = Math.max(0, Math.min(w - x, Math.round(b.width * zoom))),
    height = Math.max(0, Math.min(h - y, Math.round(b.height * zoom)));
  browser.view.setBounds({ x, y, width, height });
  browser.view.setVisible(width > 0 && height > 0);
}

async function bindScope(owner: Owner, scope: PanelScope) {
  if (
    !scope ||
    typeof scope.sessionId !== 'string' ||
    !scope.sessionId ||
    scope.sessionId.length > 200 ||
    typeof scope.root !== 'string' ||
    !path.isAbsolute(scope.root)
  )
    throw new Error('Select a session workspace first');
  const root = await fs.realpath(scope.root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Session workspace is not a directory');
  const previous = owner.roots.get(scope.sessionId);
  if (previous && previous !== root) throw new Error('A session cannot switch its workspace');
  owner.roots.set(scope.sessionId, root);
  return root;
}

function browserState(id: string, browser: BrowserState): PanelBrowserState {
  const wc = browser.view.webContents;
  return {
    id,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    back: wc.navigationHistory.canGoBack(),
    forward: wc.navigationHistory.canGoForward(),
    error: browser.error,
  };
}

function terminalFor(owner: Owner, id: string, scope: string) {
  const terminal = owner.terminals.get(id);
  if (!terminal || terminal.scope !== scope)
    throw new Error('Terminal does not belong to this session');
  return terminal;
}
function browserFor(owner: Owner, id: string, scope: string) {
  const browser = owner.browsers.get(id);
  if (!browser || browser.scope !== scope || browser.view.webContents.isDestroyed())
    throw new Error(
      'Browser does not belong to this session. Use an ID returned by a successful open; a failed open provides no usable tab. Do not guess IDs.'
    );
  return browser;
}

async function dispatch(owner: Owner, request: PanelRequest): Promise<PanelReply> {
  const root = await bindScope(owner, request.scope);
  const scope = request.scope.sessionId;
  switch (request.action) {
    case 'browser-control': {
      if (request.operation === 'open') {
        if (Boolean(request.url) === Boolean(request.htmlPath))
          throw new Error('Specify one URL or HTML path');
        let preview: Awaited<ReturnType<typeof createWorkspacePreview>> | undefined;
        let id: string | undefined;
        try {
          preview = request.htmlPath
            ? await createWorkspacePreview(root, request.htmlPath)
            : undefined;
          const url = preview?.url ?? panelUrl(request.url!);
          const created = await dispatch(owner, { scope: request.scope, action: 'browser-create' });
          id = created.id!;
          const browser = browserFor(owner, id, scope);
          browser.preview = preview;
          await browser.view.webContents.loadURL(url);
          return {
            id,
            browser: browserState(id, browser),
            result: { id, url, target: 'embedded', localPreview: Boolean(preview) },
          };
        } catch (error) {
          preview?.close();
          if (id) await dispatch(owner, { scope: request.scope, action: 'browser-close', id });
          throw new Error(
            `Browser open failed; no usable tab ID was returned. Any partially created tab was closed. Do not guess a tab ID. Local previews require HTML; use file read for Markdown or other text documents. ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const browser = browserFor(owner, request.id!, scope);
      if (request.operation === 'close') {
        await dispatch(owner, { scope: request.scope, action: 'browser-close', id: request.id! });
        return { result: { closed: true } };
      }
      return { result: await browser.controller.run(request) };
    }
    case 'list':
      return listPanelFiles(root, request.path);
    case 'search':
      return searchPanelFiles(root, request.query);
    case 'read': {
      const document = await readPanelFile(root, request.path);
      if (document.media) document.media.url = mediaFiles.grant(owner.id, root, request.path);
      return { document };
    }
    case 'read-reference': {
      const { file, document, external } = await readPanelReference(root, request.path);
      if (owners.get(owner.id) !== owner || owner.roots.get(scope) !== root)
        throw new Error('Reference or conversation changed; open the link again');
      if (!external || document.media) {
        if (document.media)
          document.media.url = mediaFiles.grant(
            owner.id,
            root,
            request.path,
            external ? file : undefined
          );
        return { document };
      }
      return { reference: { path: file, content: document.content } };
    }
    case 'inspect': {
      const file = await inspectPanelFile(root, request.path, request.reference);
      if (file.media)
        file.media.url = mediaFiles.grant(
          owner.id,
          root,
          request.path,
          file.reference ? file.path : undefined
        );
      return { file };
    }
    case 'document-preview-cancel': {
      const current = owner.documentRequests?.get(request.requestId);
      if (current?.scope === scope) current.controller.abort();
      return {};
    }
    case 'document-preview': {
      if (
        typeof request.requestId !== 'string' ||
        !request.requestId ||
        request.requestId.length > 100
      )
        throw new Error('Invalid document request');
      owner.documentRequests ??= new Map();
      if (owner.documentRequests.size >= 8 || owner.documentRequests.has(request.requestId))
        throw new Error('Too many document preview requests');
      const controller = new AbortController();
      owner.documentRequests.set(request.requestId, { scope, controller });
      try {
        const resolveFile = async () =>
          request.reference
            ? (await resolvePanelReference(root, request.path)).file
            : panelPath(root, request.path);
        const file = await resolveFile();
        if (!isPanelDocument(file)) throw new Error('Unsupported preview document');
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
          throw new Error('Document exceeds 32 MB');
        const versionOf = (info: {
          dev: number;
          ino: number;
          size: number;
          mtimeMs: number;
          ctimeMs: number;
        }) => JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
        const version = versionOf(stat);
        controller.signal.throwIfAborted();
        owner.documentPreviewer ??= (async () => {
          const runtime = app.isPackaged
            ? path.join(
                path.dirname(
                  await fs.realpath(
                    path.join(process.resourcesPath, 'harness-distribution', 'manifest.json')
                  )
                ),
                'runtime'
              )
            : path.resolve(app.getAppPath(), '../../runtime');
          const module = await import(
            /* @vite-ignore */ pathToFileURL(path.join(runtime, 'document-preview.mjs')).href
          );
          return new module.DocumentPreviewer() as DocumentPreviewer;
        })().catch((error) => {
          owner.documentPreviewer = undefined;
          throw error;
        });
        const previewer = await owner.documentPreviewer;
        const documentPreview = await previewer.render(
          {
            key: JSON.stringify([owner.id, root, file]),
            extension: path.extname(file).toLowerCase(),
            version,
            size: stat.size,
            read: async (signal, maxBytes) => {
              signal.throwIfAborted();
              if ((await resolveFile()) !== file) throw new Error('Document path changed');
              const handle = await fs.open(file, 'r');
              try {
                const current = await handle.stat();
                if (!current.isFile() || current.size > maxBytes)
                  throw new Error('Document exceeds the preview size limit');
                if (versionOf(current) !== version)
                  throw new Error('Document changed; reload its preview');
                const buffer = Buffer.alloc(current.size + 1);
                let offset = 0;
                while (offset < buffer.length) {
                  signal.throwIfAborted();
                  const read = await handle.read(buffer, offset, buffer.length - offset, offset);
                  if (!read.bytesRead) break;
                  offset += read.bytesRead;
                }
                const after = await handle.stat();
                if (offset !== current.size || versionOf(after) !== version)
                  throw new Error('Document changed; reload its preview');
                return { bytes: buffer.subarray(0, offset), version: versionOf(after) };
              } finally {
                await handle.close();
              }
            },
          },
          controller.signal
        );
        controller.signal.throwIfAborted();
        return { documentPreview };
      } catch (error) {
        if (!controller.signal.aborted)
          console.warn(
            'Document preview failed:',
            error instanceof Error ? error.message : 'Unknown preview error'
          );
        throw error;
      } finally {
        owner.documentRequests.delete(request.requestId);
      }
    }
    case 'open-external':
    case 'open-with': {
      const file = request.reference
        ? (await resolvePanelReference(root, request.path)).file
        : await externalPanelFile(root, request.path);
      if (!canOpenPanelFileExternally(file))
        throw new Error('This file type can only be previewed in CodeBuddy');
      if (isPanelEditorFile(file)) {
        const result = await openCodeFile(
          owner.win,
          file,
          request.line,
          request.action === 'open-with',
          codeEditorSettings,
          async () => {
            const current = request.reference
              ? (await resolvePanelReference(root, request.path)).file
              : await externalPanelFile(root, request.path);
            if (
              current !== file ||
              owners.get(owner.id) !== owner ||
              owner.roots.get(scope) !== root
            )
              throw new Error('Reference or conversation changed; open the link again');
          }
        );
        return result === 'preview' ? { fileAction: 'preview' } : {};
      }
      if (request.action === 'open-with') throw new Error('Choose an editor for a source file');
      // Follow the user's file association. Source locations belong to the
      // built-in preview; appending them would change the filesystem path.
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
      return {};
    }
    case 'reveal':
    case 'copy-path':
    case 'copy-image':
    case 'copy-text':
    case 'save-as':
    case 'attach-image':
    case 'file-menu': {
      const referenceAction =
        request.reference === true &&
        [
          'file-menu',
          'reveal',
          'copy-path',
          'copy-text',
          'copy-image',
          'attach-image',
          'save-as',
        ].includes(request.action);
      const file = referenceAction
        ? (await resolvePanelReference(root, request.path)).file
        : await panelPath(root, request.path);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Path is not a regular file');
      if (request.action === 'file-menu') {
        const media = panelMediaType(file);
        const image = media?.kind === 'image';
        const choices: (PanelFileMenuChoice | null)[] =
          request.kind === 'image' && image
            ? ['image-tab', 'add-to-chat', 'copy-image', 'reveal', 'save-as']
            : [
                ...(request.tabs ? [] : ['preview' as const]),
                'open-external',
                ...(isPanelEditorFile(file) ? ['open-with' as const] : []),
                null,
                'save-as',
                'copy-path',
                ...(!media && !isPanelDocument(file) ? ['copy-text' as const] : []),
                null,
                'reveal',
              ];
        const selected = await new Promise<PanelFileMenuChoice | PanelTabAction | undefined>(
          (resolve) => {
            Menu.buildFromTemplate([
              ...choices.map((action) =>
                action === 'open-with'
                  ? {
                      label: request.labels['open-with'] ?? 'Open with',
                      submenu: [
                        { label: request.labels.preview, click: () => resolve('preview') },
                        {
                          label: request.labels.codeEditor ?? 'Open in code editor',
                          click: () => resolve('open-external'),
                        },
                        {
                          label: request.labels.chooseCodeEditor ?? 'Change default code editor…',
                          click: () => resolve('open-with'),
                        },
                      ],
                    }
                  : action
                    ? {
                        label:
                          action === 'open-external' && isPanelEditorFile(file)
                            ? (request.labels.codeEditor ?? 'Open in code editor')
                            : request.labels[action],
                        enabled: action !== 'open-external' || canOpenPanelFileExternally(file),
                        click: () => resolve(action),
                      }
                    : { type: 'separator' as const }
              ),
              ...(request.tabs
                ? [
                    { type: 'separator' as const },
                    ...(['close', 'close-others', 'close-right'] as const).map((action) => ({
                      label: request.tabs!.labels[action],
                      enabled:
                        action === 'close' ||
                        (action === 'close-others' ? request.tabs!.others : request.tabs!.right),
                      click: () => resolve(action),
                    })),
                  ]
                : []),
            ]).popup({ window: owner.win, callback: () => resolve(undefined) });
          }
        );
        return selected === 'close' || selected === 'close-others' || selected === 'close-right'
          ? { fileAction: null, tabAction: selected }
          : { fileAction: selected ?? null };
      }
      if (request.action === 'reveal') shell.showItemInFolder(file);
      else if (request.action === 'copy-path') clipboard.writeText(file);
      else if (request.action === 'copy-text') {
        const document = referenceAction
          ? (await readPanelReference(root, request.path)).document
          : await readPanelFile(root, request.path);
        if (document.binary || document.media)
          throw new Error('This file cannot be copied as text');
        clipboard.writeText(document.content);
      } else if (request.action === 'copy-image') {
        if (panelMedia(file, stat.size)?.kind !== 'image') throw new Error('Not a supported image');
        const image = nativeImage.createFromPath(file);
        if (image.isEmpty()) throw new Error('Image could not be loaded');
        clipboard.writeImage(image);
      } else if (request.action === 'attach-image') {
        const media = panelMedia(file, stat.size);
        if (media?.kind !== 'image') throw new Error('Not a supported image');
        const data = await fs.readFile(file);
        if (data.length > 32 * 1024 * 1024)
          throw new Error('Image exceeds the attachment size limit');
        return {
          attachment: {
            name: path.basename(file),
            dataUrl: `data:${media.mimeType};base64,${data.toString('base64')}`,
          },
        };
      } else {
        const destination = await dialog.showSaveDialog(owner.win, {
          defaultPath: path.basename(file),
        });
        if (!destination.canceled && destination.filePath) {
          const existing = await fs
            .stat(destination.filePath)
            .catch((error: Error & { code?: string }) => {
              if (error.code !== 'ENOENT') throw error;
              return undefined;
            });
          if (
            path.relative(file, path.resolve(destination.filePath)) === '' ||
            (existing && stat.ino !== 0 && existing.dev === stat.dev && existing.ino === stat.ino)
          )
            return {};
          // The source may have moved while the user chose a destination.
          const current = referenceAction
            ? (await resolvePanelReference(root, request.path)).file
            : await panelPath(root, request.path);
          if (current !== file) throw new Error('Reference changed; open the link again');
          await fs.copyFile(current, destination.filePath);
        }
      }
      return {};
    }
    case 'save':
      return {
        document: await savePanelFile(root, request.path, request.content, request.version),
      };
    case 'terminal-create': {
      if (updatePending) throw new Error('应用正在准备更新，请在重启后打开终端。');
      if (owner.terminals.size >= 16)
        throw new Error('Close a terminal before opening another (limit: 16)');
      // Keep the native module external to Vite; resolve it from the installed application.
      const nativeRequire = createRequire(path.join(app.getAppPath(), 'package.json'));
      const nativeEntry = nativeRequire.resolve('node-pty');
      // Workers and ConPTY helper executables need real filesystem paths in packaged apps.
      const nativePath = terminalModulePath(nativeEntry, app.isPackaged, process.platform);
      const pty = nativeRequire(nativePath) as typeof import('node-pty');
      const shell = terminalShell(process.platform, process.env);
      const terminal = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: 90,
        rows: 28,
        cwd: root,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      const id = randomUUID();
      const state: TerminalState = { scope, pty: terminal, buffer: '', base: 0, exited: false };
      owner.terminals.set(id, state);
      terminal.onData((data) => {
        state.buffer += data;
        if (state.buffer.length > 1024 * 1024) {
          const trim = state.buffer.length - 1024 * 1024;
          state.base += trim;
          state.buffer = state.buffer.slice(trim);
        }
      });
      terminal.onExit(({ exitCode }) => {
        state.exited = true;
        state.buffer += `\r\n[Process exited: ${exitCode}]\r\n`;
      });
      return { id };
    }
    case 'terminal-read': {
      const state = terminalFor(owner, request.id, scope);
      const reset = request.offset < state.base;
      return {
        data: state.buffer.slice(Math.max(0, request.offset - state.base)),
        offset: state.base + state.buffer.length,
        reset,
        exited: state.exited,
      };
    }
    case 'terminal-input': {
      if (typeof request.data !== 'string' || request.data.length > 65536)
        throw new Error('Terminal input is too large');
      const state = terminalFor(owner, request.id, scope);
      if (state.exited) throw new Error('Terminal process has exited');
      state.pty.write(request.data);
      return {};
    }
    case 'terminal-resize': {
      if (![request.cols, request.rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 500))
        throw new Error('Invalid terminal dimensions');
      const state = terminalFor(owner, request.id, scope);
      if (!state.exited) state.pty.resize(request.cols, request.rows);
      return {};
    }
    case 'terminal-close': {
      const state = terminalFor(owner, request.id, scope);
      if (!state.exited) state.pty.kill();
      owner.terminals.delete(request.id);
      return {};
    }
    case 'browser-create': {
      if (owner.browsers.size >= 16)
        throw new Error('Close a browser tab before opening another (limit: 16)');
      const id = randomUUID();
      const view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: `workspace-browser-${owner.win.id}-${scope}`,
        },
      });
      const state: BrowserState = {
        scope,
        view,
        controller: new BrowserController(view.webContents),
      };
      owner.browsers.set(id, state);
      owner.win.contentView.addChildView(view);
      view.setVisible(false);
      const wc = view.webContents;
      wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);
      wc.on('will-navigate', (event, url) => {
        try {
          panelUrl(url);
        } catch {
          event.preventDefault();
          state.error = 'Only HTTP and HTTPS pages can be opened';
        }
      });
      wc.on('will-redirect', (event, url) => {
        try {
          panelUrl(url);
        } catch {
          event.preventDefault();
        }
      });
      wc.setWindowOpenHandler(({ url }) => {
        try {
          void wc.loadURL(panelUrl(url)).catch((error) => {
            state.error = String(error);
          });
        } catch {
          state.error = 'Only HTTP and HTTPS pages can be opened';
        }
        return { action: 'deny' };
      });
      wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3) state.error = description;
      });
      wc.on('did-start-loading', () => {
        state.error = undefined;
      });
      wc.on('render-process-gone', () => {
        state.error = 'The page stopped. Reload to continue.';
      });
      return { id, browser: browserState(id, state) };
    }
    case 'browser-state':
      return { browser: browserState(request.id, browserFor(owner, request.id, scope)) };
    case 'browser-navigate': {
      const browser = browserFor(owner, request.id, scope);
      const url = panelUrl(request.url);
      browser.error = undefined;
      void browser.view.webContents.loadURL(url).catch((error) => {
        browser.error = String(error);
      });
      return { browser: browserState(request.id, browser) };
    }
    case 'browser-command': {
      const wc = browserFor(owner, request.id, scope).view.webContents;
      if (request.command === 'back' && wc.navigationHistory.canGoBack())
        wc.navigationHistory.goBack();
      if (request.command === 'forward' && wc.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
      if (request.command === 'reload') wc.reload();
      if (request.command === 'stop') wc.stop();
      return {};
    }
    case 'browser-bounds': {
      const browser = browserFor(owner, request.id, scope);
      if (!request.bounds) {
        browser.bounds = null;
        browser.view.setVisible(false);
        return {};
      }
      if (!Object.values(request.bounds).every(Number.isFinite))
        throw new Error('Invalid browser bounds');
      for (const other of owner.browsers.values())
        if (other !== browser) {
          other.bounds = null;
          other.view.setVisible(false);
        }
      browser.bounds = request.bounds;
      positionBrowser(owner, browser);
      return {};
    }
    case 'browser-close': {
      const browser = browserFor(owner, request.id, scope);
      browser.preview?.close();
      owner.win.contentView.removeChildView(browser.view);
      browser.view.webContents.close();
      owner.browsers.delete(request.id);
      return {};
    }
  }
  throw new Error(
    'Unsupported workspace action. Restart CodeBuddy after updating its main process.'
  );
}

export function registerWorkspacePanel(editorSettings?: CodeEditorSettings) {
  codeEditorSettings = editorSettings ?? { get: () => null, set: () => {} };
  ipcMain.handle(
    'workspace-tab-menu',
    async (event, request: PanelTabMenuRequest): Promise<PanelReply> => {
      const owner = ownerFor(event);
      if (request.path && request.scope)
        return dispatch(owner, {
          scope: request.scope,
          action: 'file-menu',
          kind: 'link',
          path: request.path,
          labels: request.labels,
          tabs: request.tabs,
          reference: request.reference,
          line: request.line,
        });
      const tabAction = await new Promise<PanelTabAction | undefined>((resolve) => {
        Menu.buildFromTemplate(
          (['close', 'close-others', 'close-right'] as const).map((action) => ({
            label: request.tabs.labels[action],
            enabled:
              action === 'close' ||
              (action === 'close-others' ? request.tabs.others : request.tabs.right),
            click: () => resolve(action),
          }))
        ).popup({ window: owner.win, callback: () => resolve(undefined) });
      });
      return { fileAction: null, ...(tabAction ? { tabAction } : {}) };
    }
  );
  ipcMain.handle('workspace-panel', (event, request: PanelRequest) =>
    dispatch(ownerFor(event), request)
  );
  ipcMain.handle('web-link-menu', async (event, request: WebLinkMenuRequest) => {
    const owner = ownerFor(event);
    const url = panelUrl(request.url);
    const choices: WebLinkMenuChoice[] = [
      ...(request.allowPreview ? ['preview' as const] : []),
      'open-external',
      'copy-link',
      'save-link',
    ];
    const action = await new Promise<WebLinkMenuChoice | null>((resolve) => {
      Menu.buildFromTemplate(
        choices.map((choice) => ({
          label: request.labels[choice],
          click: () => resolve(choice),
        }))
      ).popup({ window: owner.win, callback: () => resolve(null) });
    });
    if (action === 'open-external') await shell.openExternal(url);
    else if (action === 'copy-link') clipboard.writeText(url);
    else if (action === 'save-link') owner.win.webContents.downloadURL(url);
    return { action: action === 'preview' ? action : null };
  });
  app.on('before-quit', () => {
    for (const owner of [...owners.values()]) dispose(owner);
  });
}
