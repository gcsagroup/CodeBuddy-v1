import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('../utils/logger', () => ({ default: { error: vi.fn(), info: vi.fn() } }));

const host = vi.hoisted(() => ({
  root: '',
  invalid: new Set<string>(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  signals: new Map<string, (...args: unknown[]) => void>(),
  cursor: { x: 1800, y: 900 },
  sender: { send: vi.fn(), on: vi.fn() },
  show: vi.fn(),
  focus: vi.fn(),
  minimized: false,
  menuChoice: -1,
  menu: vi.fn(),
  restore: vi.fn(),
  createWindow: vi.fn(),
  extraWindows: [] as Array<{
    id: number;
    isDestroyed: () => boolean;
    webContents: { send: (...args: unknown[]) => void; on: ReturnType<typeof vi.fn> };
    once: (...args: unknown[]) => void;
    show: () => void;
    focus: () => void;
  }>,
}));
vi.mock('electron', () => ({
  app: { getPath: () => host.root, getLocale: () => 'zh-CN', on: vi.fn() },
  Menu: {
    buildFromTemplate: (items: Array<{ click?: () => void }>) => {
      host.menu(items);
      return {
        popup: ({ callback }: { callback: () => void }) => {
          items[host.menuChoice]?.click?.();
          callback();
        },
      };
    },
  },
  BrowserWindow: Object.assign(host.createWindow, {
    getAllWindows: () => [
      {
        id: 1,
        isDestroyed: (): boolean => false,
        webContents: host.sender,
        once: vi.fn(),
        isFocused: () => false,
        isMinimized: () => host.minimized,
        restore: host.restore,
        show: host.show,
        focus: host.focus,
      },
      ...host.extraWindows,
    ],
    fromId: (id: number) =>
      id === 1
        ? {
            isDestroyed: (): boolean => false,
            isMinimized: () => host.minimized,
            restore: host.restore,
            show: host.show,
            focus: host.focus,
            webContents: host.sender,
          }
        : (host.extraWindows.find((window) => window.id === id) ?? null),
    fromWebContents: (contents: unknown) =>
      contents === host.sender
        ? { id: 1 }
        : (host.extraWindows.find((window) => window.webContents === contents) ?? null),
  }),
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      host.handlers.set(name, handler),
    on: (name: string, handler: (...args: unknown[]) => void) => host.signals.set(name, handler),
    removeListener: (name: string) => host.signals.delete(name),
  },
  nativeImage: {},
  screen: {
    on: vi.fn(),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getCursorScreenPoint: () => ({ ...host.cursor }),
  },
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
}));
vi.mock('./petLibrary', () => ({
  loadPetAsset: async (directory: string, builtin: boolean) => {
    const id = directory.split(/[\\/]/).pop()!;
    if (host.invalid.has(id)) throw new Error('Damaged PNG');
    return {
      schemaVersion: 1,
      id,
      name: id,
      description: '',
      image: 'sprites.png',
      columns: 6,
      rows: 8,
      cellWidth: 192,
      cellHeight: 208,
      fps: 6,
      builtin,
      imageUrl: 'data:image/png;base64,eA==',
      hash: 'a'.repeat(64),
    };
  },
}));
import { registerDesktopPet } from './petMain';
import { BrowserWindow } from 'electron';
import type { PetRequest, PetSnapshot } from './petTypes';
import { restorePetBounds } from './petPolicy';

describe('bundled pet registry and saved selection', () => {
  beforeEach(async () => {
    host.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-pet-test-')));
    host.invalid.clear();
    host.extraWindows.length = 0;
    host.handlers.clear();
    host.signals.clear();
    host.sender.send.mockReset();
    host.sender.send.mockImplementation((channel, payload) => {
      if (channel === 'pet-send-message' || channel === 'pet-resolve-permission') host.signals.get('pet-message-result')?.({ sender: host.sender }, { deliveryId: payload.deliveryId });
    });
    host.show.mockClear();
    host.focus.mockClear();
    host.minimized = false;
    host.menuChoice = -1;
    host.menu.mockClear();
    host.restore.mockClear();
    host.createWindow.mockClear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(host.root, { recursive: true, force: true });
  });
  const start = (onWorkingChange?: (working: boolean) => void,
    onQuestion?: Parameters<typeof registerDesktopPet>[0]['onQuestion'],
    onWindowCreated?: Parameters<typeof registerDesktopPet>[0]['onWindowCreated']) =>
    registerDesktopPet({
      onWorkingChange,
      onQuestion,
      onWindowCreated,
      preload: 'unused',
      rendererUrl: 'http://localhost/',
      builtinDirectory: path.join(host.root, 'bundled'),
      openChat: vi.fn(),
    });
  const request = (value: PetRequest) =>
    host.handlers.get('desktop-pet')!(
      { sender: BrowserWindow.getAllWindows()[0].webContents },
      value
    ) as Promise<PetSnapshot>;

  it('keeps the system awake while any task is working with the pet hidden', async () => {
    const working = vi.fn();
    await start(working);
    const publish = (sessionId: string, state: string) =>
      host.signals.get('pet-task')!({ sender: host.sender }, { sessionId, title: sessionId, state });
    publish('a', 'working');
    publish('b', 'working');
    publish('a', 'completed');
    expect(working).toHaveBeenLastCalledWith(true);
    publish('b', 'input');
    expect(working).toHaveBeenLastCalledWith(false);
    publish('b', 'working');
    const [, onCrash] = host.sender.on.mock.calls.find(([event]) => event === 'render-process-gone')!;
    onCrash();
    expect(working).toHaveBeenLastCalledWith(false);
  });

  it('announces each live question once and keeps it visible independently of another session', async () => {
    const remind = vi.fn();
    await start(undefined, remind);
    const publish = (sessionId: string, state: string, ids: string[]) => host.signals.get('pet-task')!(
      { sender: host.sender }, { sessionId, state, title: sessionId, questions: ids.map(id => ({ id, summary: 'Same text' })) });
    publish('a', 'working', ['1']);
    publish('a', 'idle', ['1']);
    publish('b', 'working', []);
    expect(remind).toHaveBeenCalledTimes(1);
    expect((await request({action:'get'})).task?.sessionId).toBe('a');
    publish('a', 'working', ['1', '2']);
    expect(remind.mock.calls.map(call => call[2])).toEqual(['1', '2']);
    publish('a', 'idle', []);
    expect((await request({action:'get'})).tasks?.map(t => t.sessionId)).toEqual(['b']);
  });

  it('loads all three bundled choices and persists the chosen animal separately from visibility', async () => {
    await start();
    const initial = await request({ action: 'get' });
    expect(initial.pets.map((p) => p.id)).toEqual(['red-panda', 'cream-cat', 'white-fox']);
    expect(initial.preferences).toMatchObject({ selectedId: '', visible: false });
    await expect(request({ action: 'configure', preferences: { visible: true } })).rejects.toThrow(
      'Select a pet'
    );
    expect((await request({ action: 'refresh' })).preferences.selectedId).toBe('');
    await request({ action: 'configure', preferences: { selectedId: 'white-fox' } });
    const saved = JSON.parse(
      await fs.readFile(path.join(host.root, 'pets/preferences.json'), 'utf8')
    );
    expect(saved).toMatchObject({ selectedId: 'white-fox', visible: false });
    await start();
    expect((await request({ action: 'get' })).preferences.selectedId).toBe('white-fox');
    expect(host.createWindow).not.toHaveBeenCalled();
  });

  it('keeps a completed reminder until its destination acknowledges the displayed terminal', async () => {
    await start();
    const event = { sender: host.sender };
    const publish = host.signals.get('pet-task')!;
    const read = host.signals.get('pet-read')!;
    publish(event, {
      sessionId: 'background',
      title: 'Build',
      state: 'completed',
      terminalId: 'terminal-1',
    });

    await request({ action: 'open-task' });
    expect(host.show).toHaveBeenCalledOnce();
    expect(host.focus).toHaveBeenCalledOnce();
    expect(host.sender.send).toHaveBeenCalledWith('pet-open-session', 'background');
    expect((await request({ action: 'get' })).task?.terminalId).toBe('terminal-1');

    read({ sender: {} }, { sessionId: 'background', terminalId: 'terminal-1' });
    read(event, { sessionId: 'background', terminalId: 'old-terminal' });
    expect((await request({ action: 'get' })).task?.state).toBe('completed');
    read(event, { sessionId: 'background', terminalId: 'terminal-1' });
    expect((await request({ action: 'get' })).task).toBeNull();

    publish(event, {
      sessionId: 'background',
      title: 'Build again',
      state: 'completed',
      terminalId: 'terminal-2',
    });
    read(event, { sessionId: 'background', terminalId: 'terminal-1' });
    expect((await request({ action: 'get' })).task?.terminalId).toBe('terminal-2');
  });

  it('routes an explicitly clicked lower-priority session and ignores an unknown target', async () => {
    await start();
    const publish = host.signals.get('pet-task')!;
    publish({ sender: host.sender }, { sessionId: 'a', title: 'Approval', state: 'input' });
    publish({ sender: host.sender }, { sessionId: 'b', title: 'Build', state: 'working' });
    expect((await request({ action: 'get' })).tasks?.map((t) => t.sessionId)).toEqual(['a', 'b']);
    await request({ action: 'open-task', sessionId: 'b' });
    expect(host.sender.send).toHaveBeenCalledWith('pet-open-session', 'b');
    host.show.mockClear();
    await request({ action: 'open-task', sessionId: 'unknown' });
    expect(host.show).not.toHaveBeenCalled();
  });

  it('restores a minimized owner before opening or pausing the exact conversation', async () => {
    await start();
    host.minimized = true;
    host.signals.get('pet-task')!(
      { sender: host.sender },
      { sessionId: 'live', title: 'Live', state: 'working' }
    );
    await request({ action: 'open-task', sessionId: 'live' });
    expect(host.restore).toHaveBeenCalledOnce();
    expect(host.restore.mock.invocationCallOrder[0]).toBeLessThan(
      host.focus.mock.invocationCallOrder[0]
    );
    await request({ action: 'pause-task', sessionId: 'live' });
    expect(host.sender.send).toHaveBeenCalledWith('pet-pause-session', 'live');
  });

  it('keeps live work across idle replays and routes the newest live owner across windows', async () => {
    await start();
    const second = {
      id: 7,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      webContents: { send: vi.fn(), on: vi.fn() },
      once: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      hide: vi.fn(),
    };
    host.extraWindows.push(second);
    const publish = host.signals.get('pet-task')!;
    publish({ sender: host.sender }, { sessionId: 'shared', title: 'Creating', state: 'working' });
    publish(
      { sender: second.webContents },
      { sessionId: 'shared', title: 'History', state: 'idle' }
    );
    expect((await request({ action: 'get' })).task).toMatchObject({
      title: 'Creating',
      state: 'working',
    });
    await request({ action: 'open-task', sessionId: 'shared' });
    expect(host.focus).toHaveBeenCalledOnce();
    publish(
      { sender: host.sender },
      { sessionId: 'shared', title: 'Creating', state: 'completed', terminalId: 'first' }
    );
    publish(
      { sender: second.webContents },
      { sessionId: 'shared', title: 'Next turn', state: 'working' }
    );
    expect((await request({ action: 'get' })).task?.title).toBe('Next turn');
    await request({ action: 'open-task', sessionId: 'shared' });
    expect(second.webContents.send).toHaveBeenCalledWith('pet-open-session', 'shared');
    expect(second.focus).toHaveBeenCalledOnce();
    publish(
      { sender: second.webContents },
      { sessionId: 'shared', title: 'Next turn', state: 'completed', terminalId: 'second' }
    );
    host.signals.get('pet-read')!(
      { sender: second.webContents },
      { sessionId: 'shared', terminalId: 'second' }
    );
    expect((await request({ action: 'get' })).task).toBeNull();
  });

  it('retains the validated animal after a corrupt refresh and rejects bundled ID collisions', async () => {
    await start();
    host.invalid.add('white-fox');
    await fs.mkdir(path.join(host.root, 'pets/custom/red-panda'));
    await fs.writeFile(path.join(host.root, 'pets/custom/red-panda/pet.json'), '{}');
    const refreshed = await request({ action: 'refresh' });
    expect(refreshed.pets).toHaveLength(3);
    expect(refreshed.pets.find((p) => p.id === 'red-panda')?.builtin).toBe(true);
    expect(refreshed.pets.find((p) => p.id === 'white-fox')).toBeDefined();
    expect(refreshed.errors.join('\n')).toMatch(/Damaged PNG/);
    expect(refreshed.errors.join('\n')).toMatch(/bundled pet ID/);
  });

  it('ignores image-workspace folders but retains and reports an incomplete registered pet', async () => {
    await start();
    await fs.mkdir(path.join(host.root, 'pets/custom/generated-images'));
    expect((await request({ action: 'refresh' })).errors).toEqual([]);
    expect((await request({ action: 'get' })).pets).toHaveLength(3);
    const manifest = path.join(host.root, 'pets/custom/moss/pet.json');
    await fs.mkdir(path.dirname(manifest));
    await fs.writeFile(manifest, '{}');
    await request({ action: 'refresh' });
    await fs.unlink(manifest);
    const refreshed = await request({ action: 'refresh' });
    expect(refreshed.pets.some((pet) => pet.id === 'moss')).toBe(true);
    expect(refreshed.errors.join('\n')).toMatch(/missing pet.json/);
  });

  it('does not silently select a different animal when the saved package is missing', async () => {
    host.invalid.add('red-panda');
    await start();
    expect((await request({ action: 'get' })).preferences.selectedId).toBe('');
    host.invalid.add('cream-cat');
    host.invalid.add('white-fox');
    await fs.writeFile(
      path.join(host.root, 'pets/preferences.json'),
      JSON.stringify({ visible: true, selectedId: 'red-panda' })
    );
    await expect(start()).resolves.toBeUndefined();
    expect((await request({ action: 'get' })).pets).toHaveLength(0);
    expect((await request({ action: 'get' })).preferences).toMatchObject({
      selectedId: '',
      visible: false,
    });
    expect(host.createWindow).not.toHaveBeenCalled();
  });

  it('keeps a click in place, preserves the final fast-drag position and changes hit testing only on transitions', async () => {
    vi.useFakeTimers();
    const contents = {
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      focus: vi.fn(),
      getZoomFactor: vi.fn(() => 1.5),
    };
    const floating = {
      id: 2,
      webContents: contents,
      once: vi.fn(),
      isDestroyed: () => false,
      isVisible: () => true,
      setAlwaysOnTop: vi.fn(),
      moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      setBounds: vi.fn(),
      showInactive: vi.fn(),
      hide: vi.fn(),
      setFocusable: vi.fn(),
      setSkipTaskbar: vi.fn(),
      focus: vi.fn(),
      getBounds: () => ({ x: 1700, y: 800, width: 160, height: 213 }),
    };
    host.createWindow.mockImplementation(function () {
      return floating;
    });
    const bindBackend = vi.fn(() => {
      expect(floating.loadURL).not.toHaveBeenCalled();
    });
    await start(undefined, undefined, bindBackend);
    await request({ action: 'configure', preferences: { selectedId: 'red-panda', visible: true } });
    expect(bindBackend).toHaveBeenCalledExactlyOnceWith(floating);
    await request({ action: 'configure', preferences: { size: 160 } });
    expect(bindBackend).toHaveBeenCalledTimes(1);
    const theme = { mode: 'dark', theme: 'dark', useSystemTheme: false };
    host.signals.get('broadcast-theme-change')!({ sender: host.sender }, theme);
    expect(contents.send).toHaveBeenCalledWith('theme-changed', theme);
    expect(host.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ backgroundThrottling: false }),
      })
    );
    floating.setBounds.mockClear();
    floating.showInactive.mockClear();
    floating.setIgnoreMouseEvents.mockClear();
    floating.setAlwaysOnTop.mockClear();
    floating.moveTop.mockClear();
    const event = { sender: contents };
    host.signals.get('pet-task')!({ sender: host.sender }, { sessionId: 'approval', title: 'Approval', state: 'input', inputRequest: { kind: 'permission', permission: { requestId: 'call', token: 'live', choices: [{ action: 'deny_once', label: '拒绝' }], details: 'file write' } } });
    await expect(host.handlers.get('desktop-pet')!(event, { action: 'resolve-permission', sessionId: 'approval', permission: { requestId: 'call', token: 'old', action: 'deny_once' } })).rejects.toThrow('失效');
    await host.handlers.get('desktop-pet')!(event, { action: 'resolve-permission', sessionId: 'approval', permission: { requestId: 'call', token: 'live', action: 'deny_once' } });
    expect(host.sender.send).toHaveBeenCalledWith('pet-resolve-permission', expect.objectContaining({ sessionId: 'approval', permission: { requestId: 'call', token: 'live', action: 'deny_once' } }));
    expect(host.focus).not.toHaveBeenCalled();
    expect(host.show).not.toHaveBeenCalled();
    const hit = host.signals.get('pet-hit-test')!;
    hit(event, true);
    hit(event, true);
    expect(floating.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    expect(floating.moveTop).not.toHaveBeenCalled();
    expect(floating.setAlwaysOnTop).not.toHaveBeenCalled();
    const dispatch = (action: PetRequest['action']) =>
      host.handlers.get('desktop-pet')!(event, { action });
    host.cursor = { x: 1800, y: 900 };
    vi.advanceTimersByTime(100);
    expect(contents.send).toHaveBeenLastCalledWith('pet-cursor', {
      x: 100 / 1.5,
      y: 100 / 1.5,
      reducedMotion: false,
    });
    await dispatch('drag-start');
    if (process.platform === 'win32') {
      expect(floating.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
      expect(floating.moveTop).toHaveBeenCalledTimes(1);
    }
    hit(event, false);
    expect(floating.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    await dispatch('drag-end');
    expect(floating.setBounds).not.toHaveBeenCalled();
    expect(floating.showInactive).not.toHaveBeenCalled();
    await dispatch('drag-start');
    host.cursor = { x: 1740, y: 865 };
    await dispatch('drag-end');
    const firstBounds = restorePetBounds(
      {
        visible: true,
        selectedId: 'red-panda',
        size: 160,
        reducedMotion: false,
        position: { x: 1640, y: 765 },
      },
      [{ x: 0, y: 0, width: 1920, height: 1080 }]
    );
    expect(floating.setBounds).toHaveBeenCalledWith(firstBounds);
    const saved = JSON.parse(
      await fs.readFile(path.join(host.root, 'pets/preferences.json'), 'utf8')
    );
    expect(saved).toMatchObject({
      visible: true,
      position: { x: firstBounds.x, y: firstBounds.y },
    });
    expect(floating.showInactive).not.toHaveBeenCalled();
    await dispatch('drag-start');
    host.cursor = { x: 1770, y: 895 };
    vi.advanceTimersByTime(100);
    expect(floating.setBounds).toHaveBeenLastCalledWith({
      x: 1730,
      y: 830,
      width: 160,
      height: 213,
    });
    host.cursor = { x: 1742, y: 866 };
    await dispatch('drag-end');
    const final = floating.setBounds.mock.lastCall![0];
    expect(final.x + final.width).toBeLessThanOrEqual(1920);
    expect(final.y + final.height).toBeLessThanOrEqual(1080);
    expect(final.width).toBe(320);
    // The physical cursor can already be at release when pointer-down IPC arrives.
    floating.setBounds.mockClear();
    host.cursor = { x: 1720, y: 860 };
    await host.handlers.get('desktop-pet')!(event, {
      action: 'drag-start',
      pointer: { x: 100 / 1.5, y: 100 / 1.5 },
    });
    await dispatch('drag-end');
    const quickBounds = restorePetBounds(
      {
        visible: true,
        selectedId: 'red-panda',
        size: 160,
        reducedMotion: false,
        position: { x: 1620, y: 760 },
      },
      [{ x: 0, y: 0, width: 1920, height: 1080 }]
    );
    expect(floating.setBounds).toHaveBeenLastCalledWith(quickBounds);
    await expect(
      host.handlers.get('desktop-pet')!(event, {
        action: 'drag-start',
        pointer: { x: NaN, y: 10 },
      })
    ).rejects.toThrow('Invalid pet pointer position');
    await expect(request({ action: 'send-message', message: 'hello' })).rejects.toThrow(
      'Invalid pet message'
    );
    await host.handlers.get('desktop-pet')!(event, { action: 'compose', composing: true });
    expect(host.createWindow).toHaveBeenCalledWith(expect.objectContaining({ focusable: true, skipTaskbar: true }));
    if (process.platform === 'darwin') {
      expect(host.createWindow).toHaveBeenCalledWith(expect.objectContaining({
        type: 'panel', hiddenInMissionControl: true,
      }));
    }
    expect(floating.setFocusable).not.toHaveBeenCalled();
    expect(floating.setSkipTaskbar).toHaveBeenLastCalledWith(true);
    expect(floating.focus).toHaveBeenCalledOnce();
    expect(contents.focus).toHaveBeenCalledOnce();
    floating.setIgnoreMouseEvents.mockClear();
    hit(event, false);
    expect(floating.setIgnoreMouseEvents).not.toHaveBeenCalled();
    for (const message of ['', '  ', 'x'.repeat(8001), 123]) {
      await expect(
        host.handlers.get('desktop-pet')!(event, { action: 'send-message', message })
      ).rejects.toThrow('Invalid pet message');
    }
    host.minimized = true;
    await host.handlers.get('desktop-pet')!(event, {
      action: 'send-message',
      message: ' 新的任务🙂 ',
    });
    expect(host.restore).toHaveBeenCalledOnce();
    expect(host.show).toHaveBeenCalledOnce();
    expect(host.focus).toHaveBeenCalledOnce();
    expect(host.sender.send).toHaveBeenCalledWith('pet-send-message', {
      msg: '新的任务🙂',
      images: [],
      deliveryId: expect.any(String),
    });
    expect(floating.setFocusable).not.toHaveBeenCalled();
    await host.handlers.get('desktop-pet')!(event, { action: 'compose', composing: false });
    expect(floating.setFocusable).not.toHaveBeenCalled();
    const image = { mimeType: 'image/png', data: 'eA==' };
    await host.handlers.get('desktop-pet')!(event, {
      action: 'send-message',
      message: '',
      images: [image],
    });
    expect(host.sender.send).toHaveBeenCalledWith('pet-send-message', { msg: '', images: [image], deliveryId: expect.any(String) });
    await expect(
      host.handlers.get('desktop-pet')!(event, {
        action: 'send-message',
        message: '',
        images: [{ mimeType: 'text/html', data: 'eA==' }],
      })
    ).rejects.toThrow();
    await host.handlers.get('desktop-pet')!(event, { action: 'open-composer', composerAction: 'add', message: '' });
    expect(host.sender.send).toHaveBeenCalledWith('pet-send-message', { msg: '', images: [], composerAction: 'add', deliveryId: expect.any(String) });
    await expect(host.handlers.get('desktop-pet')!(event, { action: 'open-composer', composerAction: 'send', message: 'draft' })).rejects.toThrow();
    await expect(request({ action: 'open-composer', composerAction: 'add', message: 'draft' })).rejects.toThrow();
    await expect(request({ action: 'context-menu' })).rejects.toThrow('Pet menu request denied');
    host.menuChoice = 0;
    await dispatch('context-menu');
    expect(host.sender.send).toHaveBeenCalledWith('set-view', 'settings', 'pets');
    expect(host.menu.mock.calls[0][0][0].label).toBe('宠物设置');
    host.menuChoice = 2;
    await dispatch('context-menu');
    expect(floating.hide).toHaveBeenCalled();
    expect((await request({ action: 'get' })).preferences.visible).toBe(false);
    const hiddenPrefs = JSON.parse(
      await fs.readFile(path.join(host.root, 'pets/preferences.json'), 'utf8')
    );
    expect(hiddenPrefs.visible).toBe(false);
  });
});
