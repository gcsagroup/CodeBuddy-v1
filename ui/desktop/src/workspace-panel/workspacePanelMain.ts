import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import { terminalModulePath, terminalShell } from './workspacePanelTerminal';
import type {
  PanelBrowserState,
  PanelReply,
  PanelRequest,
  PanelScope,
} from './workspacePanelTypes';
import {
  listPanelFiles,
  inspectPanelFile,
  externalPanelDocument,
  panelUrl,
  readPanelFile,
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
}
interface Owner {
  id: number;
  win: BrowserWindow;
  roots: Map<string, string>;
  terminals: Map<string, TerminalState>;
  browsers: Map<string, BrowserState>;
}
const owners = new Map<number, Owner>();

function dispose(owner: Owner) {
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
    const current = owner;
    win.once('closed', () => dispose(current));
    win.webContents.on('render-process-gone', () => dispose(current));
    win.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) dispose(current);
    });
  }
  return owner;
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
    throw new Error('Browser does not belong to this session');
  return browser;
}

async function dispatch(owner: Owner, request: PanelRequest): Promise<PanelReply> {
  const root = await bindScope(owner, request.scope);
  const scope = request.scope.sessionId;
  switch (request.action) {
    case 'list':
      return listPanelFiles(root, request.path);
    case 'search':
      return searchPanelFiles(root, request.query);
    case 'read':
      return { document: await readPanelFile(root, request.path) };
    case 'inspect':
      return { file: await inspectPanelFile(root, request.path) };
    case 'open-external': {
      const error = await shell.openPath(await externalPanelDocument(root, request.path));
      if (error) throw new Error(error);
      return {};
    }
    case 'save':
      return {
        document: await savePanelFile(root, request.path, request.content, request.version),
      };
    case 'terminal-create': {
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
      const state: BrowserState = { scope, view };
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
        browser.view.setVisible(false);
        return {};
      }
      for (const other of owner.browsers.values())
        if (other !== browser) other.view.setVisible(false);
      const b = request.bounds,
        [w, h] = owner.win.getContentSize();
      if (!Object.values(b).every(Number.isFinite)) throw new Error('Invalid browser bounds');
      const zoom = owner.win.webContents.getZoomFactor();
      const x = Math.max(0, Math.min(w, Math.round(b.x * zoom))),
        y = Math.max(0, Math.min(h, Math.round(b.y * zoom)));
      const width = Math.max(0, Math.min(w - x, Math.round(b.width * zoom))),
        height = Math.max(0, Math.min(h - y, Math.round(b.height * zoom)));
      browser.view.setBounds({ x, y, width, height });
      browser.view.setVisible(width > 0 && height > 0);
      return {};
    }
    case 'browser-close': {
      const browser = browserFor(owner, request.id, scope);
      owner.win.contentView.removeChildView(browser.view);
      browser.view.webContents.close();
      owner.browsers.delete(request.id);
      return {};
    }
  }
}

export function registerWorkspacePanel() {
  ipcMain.handle('workspace-panel', (event, request: PanelRequest) =>
    dispatch(ownerFor(event), request)
  );
  app.on('before-quit', () => {
    for (const owner of [...owners.values()]) dispose(owner);
  });
}
