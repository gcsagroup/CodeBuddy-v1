import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadPetAsset, type PetPixels } from './petLibrary';
import {
  builtinPetIds,
  defaultPetPreferences,
  normalizePetPreferences,
  restorePetBounds,
  sortPetTasks,
} from './petPolicy';
import type { PetAsset, PetPreferences, PetRequest, PetSnapshot, PetTask } from './petTypes';
import log from '../utils/logger';
import { parsePetMessage, parsePetComposerAction } from './petMessage';
import { selectNativeText } from '../utils/nativeLocalization';

const auxiliaryWindows = new Set<number>();
export function applicationWindows() {
  return BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !auxiliaryWindows.has(w.id)
  );
}
export function markAuxiliaryWindow(window: BrowserWindow) {
  auxiliaryWindows.add(window.id);
  window.once('closed', () => auxiliaryWindows.delete(window.id));
}

function decodePng(bytes: Buffer): PetPixels {
  const image = nativeImage.createFromBuffer(bytes);
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const rgba = new Uint8Array(bgra);
  for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
  return { width, height, rgba };
}

export async function registerDesktopPet(options: {
  preload: string;
  rendererUrl: string;
  builtinDirectory: string;
  openChat: (options: {
    query?: string;
    dir?: string;
    resumeSessionId?: string;
    noAutoSubmit?: boolean;
    images?: import('../types/message').ImageData[];
    settings?: boolean;
  }) => Promise<unknown>;
}) {
  const root = path.join(app.getPath('userData'), 'pets');
  const creationDirectory = path.join(root, 'custom');
  const preferencesFile = path.join(root, 'preferences.json');
  await fsp.mkdir(creationDirectory, { recursive: true });
  let preferences: PetPreferences;
  try {
    preferences = normalizePetPreferences(JSON.parse(await fsp.readFile(preferencesFile, 'utf8')));
  } catch {
    preferences = { ...defaultPetPreferences };
  }
  const pets = new Map<string, PetAsset>();
  let errors: string[] = [];
  let petWindow: BrowserWindow | null = null;
  let ignoresMouse = true;
  let composing = false;
  let messageWindowId: number | undefined;
  let drag: {
    cursor: { x: number; y: number };
    x: number;
    y: number;
    width: number;
    height: number;
    moved: boolean;
  } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const tasksByWindow = new Map<number, Map<string, PetTask>>();
  const taskUpdates = new WeakMap<PetTask, number>();
  let taskSequence = 0;
  const readTerminals = new Map<string, string>();
  const visibleTasks = () => {
    const latest = new Map<string, PetTask>();
    for (const tasks of tasksByWindow.values()) {
      for (const task of tasks.values()) {
        // A second window can replay this chat as idle while its original window is live.
        if (task.state === 'idle') continue;
        const previous = latest.get(task.sessionId);
        if (!previous || taskUpdates.get(task)! > taskUpdates.get(previous)!)
          latest.set(task.sessionId, task);
      }
    }
    return sortPetTasks(
      [...latest.values()].map((t) =>
        t.terminalId && readTerminals.get(t.sessionId) === t.terminalId
          ? { ...t, state: 'idle' as const }
          : t
      )
    );
  };
  const selectedTask = () => visibleTasks()[0] || null;
  const snapshot = (): PetSnapshot => ({
    preferences,
    pets: [...pets.values()],
    errors,
    creationDirectory,
    task: selectedTask(),
    tasks: visibleTasks(),
  });
  const save = () => {
    fs.writeFileSync(`${preferencesFile}.tmp`, JSON.stringify(preferences, null, 2));
    fs.renameSync(`${preferencesFile}.tmp`, preferencesFile);
  };
  const broadcast = () => {
    const value = snapshot();
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('pet-changed', value);
  };
  const refresh = async () => {
    errors = [];
    // A corrupt update never replaces the last validated bytes in memory or on disk.
    for (const id of builtinPetIds) {
      try {
        const pet = await loadPetAsset(path.join(options.builtinDirectory, id), true, decodePng);
        if (pet.id !== id) throw new Error('Bundled pet ID must match its folder');
        pets.set(id, pet);
      } catch (error) {
        errors.push(`${id}: ${String(error)}`);
      }
    }
    for (const entry of await fsp.readdir(creationDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      try {
        const directory = path.join(creationDirectory, entry.name);
        const manifest = await fsp.stat(path.join(directory, 'pet.json')).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!manifest) {
          if (!pets.has(entry.name)) continue;
          throw new Error('Registered pet is missing pet.json');
        }
        const pet = await loadPetAsset(directory, false, decodePng);
        if (
          builtinPetIds.some((id) => id === pet.id) ||
          pet.id === 'buddy' ||
          pet.id !== entry.name
        )
          throw new Error('Pet ID must match its folder and must not use a bundled pet ID');
        const cache = path.join(root, 'accepted', pet.id);
        await fsp.mkdir(cache, { recursive: true });
        const bytes = Buffer.from(pet.imageUrl.split(',')[1], 'base64');
        // Immutable content-addressed art; manifest is the atomic publication point.
        const image = `${pet.hash}.png`;
        await fsp.writeFile(path.join(cache, image), bytes);
        await fsp.writeFile(
          path.join(cache, 'current.json.tmp'),
          JSON.stringify({ ...pet, imageUrl: undefined, image })
        );
        await fsp.rename(path.join(cache, 'current.json.tmp'), path.join(cache, 'current.json'));
        pets.set(pet.id, pet);
      } catch (error) {
        errors.push(`${entry.name}: ${String(error)}`);
      }
    }
    if (preferences.selectedId && !pets.has(preferences.selectedId)) {
      errors.push(`Selected pet is unavailable: ${preferences.selectedId}`);
      preferences = { ...preferences, selectedId: '', visible: false };
    }
  };
  // Recover accepted packages even if a later source edit is corrupt or incomplete.
  const accepted = path.join(root, 'accepted');
  for (const entry of await fsp.readdir(accepted, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const cached = JSON.parse(
        await fsp.readFile(path.join(accepted, entry.name, 'current.json'), 'utf8')
      );
      if (!/^[a-f0-9]{64}\.png$/.test(cached.image)) continue;
      const bytes = await fsp.readFile(path.join(accepted, entry.name, cached.image));
      const { validatePetManifest } = await import('./petPolicy');
      const { validatePetPixels } = await import('./petLibrary');
      const manifest = validatePetManifest({ ...cached, image: 'sprites.png' });
      if (
        manifest.id !== entry.name ||
        builtinPetIds.some((id) => id === manifest.id) ||
        manifest.id === 'buddy'
      )
        continue;
      validatePetPixels(decodePng(bytes));
      pets.set(manifest.id, {
        ...manifest,
        builtin: false,
        hash: cached.hash,
        imageUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      });
    } catch {
      /* Ignore damaged cache and retain bundled fallback. */
    }
  }
  await refresh();
  const restoreOverlayOrder = () => {
    if (process.platform === 'win32' && petWindow?.isVisible()) {
      // Windows mouse-pass-through style changes can lower a transparent overlay.
      // Restore its z-order without activating it or stealing keyboard focus.
      petWindow.setAlwaysOnTop(true, 'screen-saver');
      petWindow.moveTop();
    }
  };
  function syncWindow() {
    if (!preferences.visible || !pets.has(preferences.selectedId)) {
      petWindow?.hide();
      return;
    }
    if (!petWindow || petWindow.isDestroyed()) {
      petWindow = new BrowserWindow({
        ...restorePetBounds(
          preferences,
          screen.getAllDisplays().map((d) => d.workArea)
        ),
        title: 'CodeBuddy Pet',
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        skipTaskbar: true,
        // Keep a native input context for Windows IME. showInactive and mouse
        // pass-through keep the idle pet from activating itself.
        focusable: true,
        alwaysOnTop: true,
        show: false,
        webPreferences: {
          preload: options.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // The overlay must animate while another app is active.
          backgroundThrottling: false,
        },
      });
      markAuxiliaryWindow(petWindow);
      ignoresMouse = true;
      petWindow.setIgnoreMouseEvents(true, { forward: true });
      const url = new URL(options.rendererUrl);
      url.hash = '/desktop-pet';
      petWindow.webContents.on('preload-error', (_event, _path, error) =>
        log.error('Pet preload failed', error.message)
      );
      petWindow.webContents.on('render-process-gone', (_event, details) =>
        log.error('Pet renderer exited', details.reason)
      );
      petWindow.webContents.once('did-finish-load', () => {
        log.info('Pet page loaded', petWindow?.webContents.getURL());
      });
      petWindow.webContents.on('console-message', (_event, level, message) => {
        if (level >= 3) log.error('Pet renderer', message);
      });
      void petWindow
        .loadURL(url.href)
        .catch((error: Error) => log.error('Pet page failed to load', error.message));
      petWindow.once('ready-to-show', () => {
        if (preferences.visible) {
          petWindow?.showInactive();
          restoreOverlayOrder();
        }
      });
      petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      petWindow.webContents.on('will-navigate', (event) => event.preventDefault());
      petWindow.once('closed', () => {
        petWindow = null;
      });
    }
    petWindow.setBounds(
      restorePetBounds(
        preferences,
        screen.getAllDisplays().map((d) => d.workArea)
      )
    );
    petWindow.showInactive();
    restoreOverlayOrder();
    if (!timer)
      timer = setInterval(() => {
        if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
        const cursor = screen.getCursorScreenPoint();
        if (
          drag &&
          (drag.moved || Math.hypot(cursor.x - drag.cursor.x, cursor.y - drag.cursor.y) >= 6)
        ) {
          drag.moved = true;
          // Keep dimensions fixed across DPI-scaled Windows position updates.
          petWindow.setBounds({
            x: Math.round(drag.x + cursor.x - drag.cursor.x),
            y: Math.round(drag.y + cursor.y - drag.cursor.y),
            width: drag.width,
            height: drag.height,
          });
        }
        const bounds = petWindow.getBounds();
        // Electron screen/bounds are DIP; DOM hit testing uses zoomed CSS pixels.
        const zoom = petWindow.webContents.getZoomFactor();
        petWindow.webContents.send('pet-cursor', {
          x: (cursor.x - bounds.x) / zoom,
          y: (cursor.y - bounds.y) / zoom,
          reducedMotion: preferences.reducedMotion,
        });
      }, 100);
  }
  let queue = Promise.resolve();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(creationDirectory, { recursive: true }, () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      queue = queue
        .then(async () => {
          await refresh();
          broadcast();
        })
        .catch((error) => log.error('Pet library refresh failed', String(error)));
    }, 500);
  });
  watcher.on('error', (error) => log.error('Pet library watcher failed', error.message));
  watcher.unref();
  ipcMain.handle('desktop-pet', (event, request: PetRequest) => {
    const result = queue.then(async () => {
      if (!request || typeof request.action !== 'string') throw new Error('Invalid pet request');
      const fromPet = event.sender === petWindow?.webContents;
      if (
        fromPet &&
        ![
          'get',
          'open-task',
          'pause-task',
          'drag-start',
          'drag-end',
          'compose',
          'context-menu',
          'send-message',
          'open-composer',
          'resolve-permission',
        ].includes(request.action)
      )
        throw new Error('Pet window request denied');
      if (!fromPet && !applicationWindows().some((w) => w.webContents === event.sender))
        throw new Error('Unknown pet client');
      switch (request.action) {
        case 'context-menu': {
          if (!fromPet) throw new Error('Pet menu request denied');
          const label = (en: string, cn: string, tw: string) =>
            selectNativeText(app.getLocale(), en, cn, tw);
          petWindow!.setSkipTaskbar(true);
          const choice = await new Promise<'hide' | 'settings' | undefined>((resolve) => {
            Menu.buildFromTemplate([
              {
                label: label('Pet settings', '宠物设置', '寵物設定'),
                click: () => resolve('settings'),
              },
              { type: 'separator' },
              { label: label('Hide pet', '隐藏宠物', '隱藏寵物'), click: () => resolve('hide') },
            ]).popup({ window: petWindow!, callback: () => resolve(undefined) });
          });
          petWindow?.setSkipTaskbar(true);
          if (choice === 'hide') {
            preferences = { ...preferences, visible: false };
            save();
            syncWindow();
          } else if (choice === 'settings') {
            const destination = applicationWindows()[0];
            if (destination) {
              if (destination.isMinimized()) destination.restore();
              destination.show();
              destination.focus();
              destination.webContents.send('set-view', 'settings', 'pets');
            } else await options.openChat({ settings: true });
          }
          restoreOverlayOrder();
          break;
        }
        case 'compose':
          if (!fromPet || typeof request.composing !== 'boolean')
            throw new Error('Invalid pet composer request');
          composing = request.composing;
          petWindow!.setSkipTaskbar(true);
          if (request.composing) {
            petWindow!.setIgnoreMouseEvents(false);
            ignoresMouse = false;
            petWindow!.focus();
            petWindow!.webContents.focus();
          }
          restoreOverlayOrder();
          break;
        case 'open-composer':
        case 'send-message': {
          if (!fromPet) throw new Error('Invalid pet message');
          const composerAction = request.action === 'open-composer' ? parsePetComposerAction(request.composerAction) : undefined;
          const message = parsePetMessage({ msg: request.message, images: request.images ?? [] }, !!composerAction);
          if (!applicationWindows().length) await options.openChat({});
          const windows = applicationWindows();
          const destination = windows.find(window => window.id === messageWindowId) ?? windows[0];
          if (!destination) throw new Error('无法打开主对话窗口，请重试');
          messageWindowId = destination.id;
          if (destination.isMinimized()) destination.restore();
          destination.show();
          destination.focus();
          const deliveryId = randomUUID();
          await new Promise<void>((resolve, reject) => {
            const finish = (_event: Electron.IpcMainEvent, result: { deliveryId?: string; error?: string }) => {
              if (_event.sender !== destination.webContents || result?.deliveryId !== deliveryId) return;
              clearTimeout(timeout);
              ipcMain.removeListener('pet-message-result', finish);
              if (result.error) reject(new Error(result.error)); else resolve();
            };
            const timeout = setTimeout(() => {
              ipcMain.removeListener('pet-message-result', finish);
              reject(new Error('主对话接收超时，请先检查主对话的消息队列，避免重复发送'));
            }, 30000);
            ipcMain.on('pet-message-result', finish);
            destination.webContents.send('pet-send-message', { ...message, deliveryId, ...(composerAction ? { composerAction } : {}) });
          });
          composing = false;
          petWindow!.setSkipTaskbar(true);
          restoreOverlayOrder();
          break;
        }
        case 'get':
          return snapshot();
        case 'refresh':
          await refresh();
          save();
          syncWindow();
          break;
        case 'configure': {
          const p = request.preferences;
          if (!p || (p.selectedId !== undefined && p.selectedId !== '' && !pets.has(p.selectedId)))
            throw new Error('Unknown pet');
          if (p.visible === true && !pets.has(p.selectedId ?? preferences.selectedId))
            throw new Error('Select a pet before showing it');
          preferences = normalizePetPreferences({
            ...preferences,
            ...p,
            position: preferences.position,
          });
          save();
          syncWindow();
          break;
        }
        case 'drag-start':
          if (fromPet && petWindow) {
            const b = petWindow.getBounds();
            const point = request.pointer;
            const zoom = petWindow.webContents.getZoomFactor();
            if (
              point &&
              (!Number.isFinite(point.x) ||
                !Number.isFinite(point.y) ||
                point.x < 0 ||
                point.y < 0 ||
                point.x * zoom > b.width ||
                point.y * zoom > b.height)
            ) {
              throw new Error('Invalid pet pointer position');
            }
            // IPC can arrive after a fast gesture has already moved the cursor.
            // Preserve the actual pointer-down position in window CSS coordinates.
            const cursor = point
              ? { x: b.x + point.x * zoom, y: b.y + point.y * zoom }
              : screen.getCursorScreenPoint();
            drag = { cursor, ...b, moved: false };
            restoreOverlayOrder();
          }
          break;
        case 'drag-end':
          if (fromPet && petWindow) {
            const start = drag;
            drag = null;
            const cursor = screen.getCursorScreenPoint();
            if (
              start &&
              (start.moved || Math.hypot(cursor.x - start.cursor.x, cursor.y - start.cursor.y) >= 6)
            ) {
              // Use the release point even when a quick drag finishes between cursor polls.
              preferences.position = {
                x: start.x + cursor.x - start.cursor.x,
                y: start.y + cursor.y - start.cursor.y,
              };
              const bounds = restorePetBounds(
                preferences,
                screen.getAllDisplays().map((d) => d.workArea)
              );
              preferences.position = { x: bounds.x, y: bounds.y };
              petWindow.setBounds(bounds);
              save();
            }
            restoreOverlayOrder();
          }
          break;
        case 'resolve-permission': {
          if (!fromPet || !request.sessionId || !request.permission) throw new Error('Invalid pet approval');
          const { requestId, token, action } = request.permission;
          const owner = [...tasksByWindow].find(([, tasks]) => {
            const pending = tasks.get(request.sessionId!)?.inputRequest?.permission;
            return pending?.requestId === requestId && pending.token === token && pending.choices.some(choice => choice.action === action);
          });
          const destination = owner && BrowserWindow.fromId(owner[0]);
          if (!destination || destination.isDestroyed()) throw new Error('审批请求已失效，请查看最新通知');
          const deliveryId = randomUUID();
          await new Promise<void>((resolve, reject) => {
            const finish = (reply: Electron.IpcMainEvent, result: { deliveryId?: string; error?: string }) => {
              if (reply.sender !== destination.webContents || result?.deliveryId !== deliveryId) return;
              clearTimeout(timeout); ipcMain.removeListener('pet-message-result', finish);
              if (result.error) reject(new Error(result.error)); else resolve();
            };
            const timeout = setTimeout(() => { ipcMain.removeListener('pet-message-result', finish); reject(new Error('审批结果尚未确认，请检查最新通知')); }, 10000);
            ipcMain.on('pet-message-result', finish);
            destination.webContents.send('pet-resolve-permission', { sessionId: request.sessionId, permission: request.permission, deliveryId });
          });
          break;
        }
        case 'open-task':
        case 'pause-task': {
          const task =
            request.sessionId === undefined
              ? selectedTask()
              : visibleTasks().find((item) => item.sessionId === request.sessionId);
          if (task) {
            // Navigation is a request; only the visible destination acknowledges reading.
            const owner = [...tasksByWindow].find(
              ([, tasks]) => tasks.get(task.sessionId) === task
            );
            const window = owner && BrowserWindow.fromId(owner[0]);
            if (window && !window.isDestroyed()) {
              if (window.isMinimized()) window.restore();
              window.show();
              window.focus();
              window.webContents.send(
                request.action === 'pause-task' ? 'pet-pause-session' : 'pet-open-session',
                task.sessionId
              );
              log.info('Pet session action', request.action, task.sessionId, window.id);
            } else await options.openChat({ resumeSessionId: task.sessionId });
            // Raising a normal window after the pet's hit-test can cover a transparent
            // overlay on Windows. Restore the overlay after the destination is raised.
            restoreOverlayOrder();
          }
          break;
        }
        case 'create':
          event.sender.send('pet-create-session', {
            dir: creationDirectory,
            query: creationPrompt(creationDirectory),
          });
          break;
        default:
          throw new Error('Unknown pet action');
      }
      broadcast();
      return snapshot();
    });
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  });
  ipcMain.on('pet-hit-test', (event, opaque: unknown) => {
    if (event.sender === petWindow?.webContents && typeof opaque === 'boolean') {
      const ignore = !composing && !opaque && !drag;
      if (ignore !== ignoresMouse) {
        ignoresMouse = ignore;
        petWindow?.setIgnoreMouseEvents(ignore, { forward: true });
        // Passive hover must not raise us over another app's capture overlay.
        // Explicit pet clicks and our own window activation restore the z-order.
      }
    }
  });
  ipcMain.on('pet-task', (event, task: PetTask) => {
    const window = applicationWindows().find((w) => w.webContents === event.sender);
    if (
      !window ||
      !task ||
      typeof task.sessionId !== 'string' ||
      typeof task.title !== 'string' ||
      !['idle', 'working', 'completed', 'blocked', 'input'].includes(task.state)
    )
      return;
    let tasks = tasksByWindow.get(window.id);
    if (!tasks) {
      tasks = new Map();
      tasksByWindow.set(window.id, tasks);
      window.once('closed', () => {
        tasksByWindow.delete(window.id);
        broadcast();
      });
    }
    taskUpdates.set(task, ++taskSequence);
    tasks.set(task.sessionId, task);
    broadcast();
  });
  ipcMain.on('pet-read', (event, input: { sessionId: string; terminalId: string }) => {
    if (
      !applicationWindows().some((w) => w.webContents === event.sender) ||
      !input ||
      typeof input.sessionId !== 'string' ||
      typeof input.terminalId !== 'string'
    )
      return;
    const task = tasksByWindow
      .get(BrowserWindow.fromWebContents(event.sender)!.id)
      ?.get(input.sessionId);
    if (task?.terminalId === input.terminalId) {
      readTerminals.set(input.sessionId, input.terminalId);
      broadcast();
    }
  });
  const restore = () => {
    if (petWindow && !drag) {
      syncWindow();
      broadcast();
    }
  };
  app.on('browser-window-focus', restoreOverlayOrder);
  screen.on('display-removed', restore);
  screen.on('display-metrics-changed', restore);
  app.on('before-quit', () => {
    watcher.close();
    clearTimeout(refreshTimer);
    if (timer) clearInterval(timer);
    timer = null;
    drag = null;
  });
  syncWindow();
}

function creationPrompt(directory: string) {
  return `请帮我制作一个属于自己的桌面宠物：

宠物形象：（例如小熊猫、小兔、机器人）
名字：
主要颜色：
画面风格：（例如温暖手绘、像素、立体卡通）
性格和动作特点：
补充要求：

请根据以上要求调用内置 generate_image 和 create_desktop_pet 制作完整动画。若关键信息仍为空，请先用 ask_user_question 向我提问。素材保存在当前工作区 ${directory}。完成后加入宠物预览列表，等我点击“设为桌面宠物”再启用。`;
}
