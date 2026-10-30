import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
type Bounds = { x: number; y: number; width: number; height: number };
type Callback = (...args: unknown[]) => void;
type WindowMock = {
  bounds: Bounds;
  destroyed: boolean;
  options: Bounds & { focusable?: boolean };
  setBounds: ReturnType<typeof vi.fn<(value: Bounds) => void>>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setContentProtection: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  webContents: { executeJavaScript: ReturnType<typeof vi.fn<(code: string) => Promise<boolean>>> };
};
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Callback>(),
  windows: [] as WindowMock[],
  shortcut: undefined as (() => void) | undefined,
  owner: { id: 1, send: vi.fn(), on: vi.fn(), once: vi.fn(), isDestroyed: () => false },
  cursor: { x: 10, y: 10 },
  displays: [] as { id: number; bounds: { x: number; y: number; width: number; height: number } }[],
  displayHandlers: new Map<string, Callback>(),
}));
vi.mock('./pets/petMain', () => ({
  applicationWindows: () => [{ webContents: mock.owner }],
  markAuxiliaryWindow: vi.fn(),
}));
vi.mock('./desktopControlKeyboard', () => ({
  createDesktopEscape: (cancel: (token: string) => void, ready: (ready: boolean) => void) => ({
    arm: (token: string) => {
      mock.shortcut = () => cancel(token);
      ready(Boolean(token));
    },
    close: vi.fn(),
  }),
}));
vi.mock('electron', () => ({
  app: { once: vi.fn(), isPackaged: false, getAppPath: () => "/repo/ui/desktop" },
  ipcMain: { on: (name: string, fn: Callback) => mock.handlers.set(name, fn) },
  screen: {
    getAllDisplays: () => mock.displays,
    getCursorScreenPoint: () => mock.cursor,
    on: (name: string, fn: Callback) => mock.displayHandlers.set(name, fn),
  },
  BrowserWindow: class {
    bounds = { x: 0, y: 0, width: 420, height: 40 };
    destroyed = false;
    setBounds = vi.fn((value: Bounds) => {
      this.bounds = value;
    });
    getBounds = () => this.bounds;
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setContentProtection = vi.fn();
    setTitle = vi.fn();
    loadURL = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    visible = false;
    showInactive = vi.fn(() => { this.visible = true; });
    hide = vi.fn(() => { this.visible = false; });
    isVisible = () => !this.destroyed && this.visible;
    webContents = {
      executeJavaScript: vi.fn<(code: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
    };
    constructor(public options: Bounds & { focusable?: boolean }) {
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      mock.windows.push(this);
    }
  },
}));
import { registerDesktopControl } from './desktopControlMain';
describe('desktop control overlay lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.windows.length = 0;
    mock.handlers.clear();
    mock.displayHandlers.clear();
    mock.cursor = { x: 10, y: 10 };
    mock.displays = [
      { id: 1, bounds: { x: -1200, y: 0, width: 1200, height: 800 } },
      { id: 2, bounds: { x: 0, y: -200, width: 1920, height: 1080 } },
    ];
    vi.clearAllMocks();
    registerDesktopControl();
  });
  afterEach(() => {
    mock.handlers.get('desktop-control-state')?.({ sender: mock.owner }, null);
    vi.useRealTimers();
  });
  const send = (token: string, active: boolean, sessionId = 's') =>
    mock.handlers.get('desktop-control-state')!(
      { sender: mock.owner },
      { sessionId, token, active }
    );
  it('shows fixed nonactivating, click-through feedback on both displays and stops pointer sampling when idle', async () => {
    send('one', true);
    await Promise.resolve();
    expect(mock.windows).toHaveLength(2);
    for (const [index, window] of mock.windows.entries()) {
      expect(window.options.focusable).toBe(false);
      expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
      expect(window.setContentProtection).toHaveBeenCalledWith(true);
      expect(window.setTitle).toHaveBeenCalledWith('');
      expect(window.showInactive).toHaveBeenCalledOnce();
      expect(window.bounds).toEqual(mock.displays[index].bounds);
      const html = decodeURIComponent(window.loadURL.mock.calls[0][0]);
      expect(html).toContain('class="glow"');
      expect(html).toMatch(/\.banner\{position:fixed;top:\d+px;left:50%/);
    }
    mock.cursor = { x: -600, y: 20 };
    vi.advanceTimersByTime(60_000);
    expect(mock.windows.every((window) => window.setBounds.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    send('one', false);
    expect(mock.windows.every((window) => !window.destroyed && window.hide.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('moves the pointer between negative-coordinate displays without moving banners or queuing renderer frames', async () => {
    send('one', true);
    await vi.advanceTimersByTimeAsync(40);
    for (const window of mock.windows) window.webContents.executeJavaScript.mockClear();
    mock.cursor = { x: -600, y: 100 };
    await vi.advanceTimersByTimeAsync(40);
    expect(mock.windows[0].webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('translate3d(598px,98px,0)')
    );
    expect(mock.windows[1].webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('"none"')
    );
    const count = mock.windows[0].webContents.executeJavaScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.windows[0].webContents.executeJavaScript).toHaveBeenCalledTimes(count);
    mock.windows[0].webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    mock.cursor.x++;
    await vi.advanceTimersByTimeAsync(40);
    mock.cursor.x++;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.windows[0].webContents.executeJavaScript).toHaveBeenCalledTimes(count + 1);
    expect(mock.windows[0].setBounds).toHaveBeenCalledOnce();
  });
  it('reuses surfaces during repeated tool events and updates only changed display bounds', async () => {
    send('one', true);
    await Promise.resolve();
    for (let i = 0; i < 100; i++) send('one', true);
    expect(mock.windows).toHaveLength(2);
    expect(mock.windows.every((window) => window.setBounds.mock.calls.length === 1)).toBe(true);
    mock.displays[1].bounds = { x: 0, y: 0, width: 1280, height: 720 };
    mock.displayHandlers.get('display-metrics-changed')!();
    expect(mock.windows[1].bounds).toEqual(mock.displays[1].bounds);
    expect(mock.windows[0].setBounds).toHaveBeenCalledOnce();
    expect(mock.windows[1].setBounds).toHaveBeenCalledTimes(2);
  });
  it('keeps the pointer label inside the bottom-right edge', async () => {
    send('one', true);
    mock.cursor = { x: 1915, y: 875 };
    await vi.advanceTimersByTimeAsync(40);
    const calls = mock.windows[1].webContents.executeJavaScript.mock.calls
      .map(([code]) => code)
      .join('\n');
    expect(calls).toContain('label.style.left="-70px"');
    expect(calls).toContain('label.style.top="-24px"');
  });
  it('handles hotplug during control, removes detached surfaces, and stays idle after completion', async () => {
    send('one', true);
    mock.displays.splice(0, 1);
    mock.displayHandlers.get('display-removed')!();
    expect(mock.windows[0].destroyed).toBe(true);
    mock.displays.push({ id: 3, bounds: { x: 1920, y: 0, width: 800, height: 1200 } });
    mock.displayHandlers.get('display-added')!();
    await Promise.resolve();
    expect(mock.windows).toHaveLength(3);
    expect(mock.windows[0].showInactive).not.toHaveBeenCalled();
    expect(mock.windows[2].bounds).toEqual(mock.displays[1].bounds);
    send('one', false);
    mock.displayHandlers.get('display-added')!();
    expect(mock.windows).toHaveLength(3);
    expect(mock.windows.filter(window => !window.destroyed).every(window => window.hide.mock.calls.length > 0)).toBe(true);
  });
  it('does not resurrect surfaces when the task ends before HTML loads', async () => {
    send('one', true);
    send('one', false);
    await Promise.resolve();
    expect(mock.windows.every((window) => !window.destroyed && window.hide.mock.calls.length > 0)).toBe(true);
    expect(mock.windows.every((window) => window.showInactive.mock.calls.length === 0)).toBe(true);
  });
  it('keeps loading surfaces available across pause and resume', async () => {
    send('one', true);
    send('one', false);
    send('two', true);
    await Promise.resolve();
    expect(mock.windows).toHaveLength(2);
    expect(mock.windows.every(window => !window.destroyed)).toBe(true);
    expect(mock.windows.every(window => window.showInactive.mock.calls.length === 1)).toBe(true);
  });
  it('does not repeatedly resize for fractional DPI rounding', async () => {
    send('one', true);
    await Promise.resolve();
    mock.windows[0].bounds.width += 1;
    for (let i = 0; i < 20; i++) send('one', true);
    expect(mock.windows[0].setBounds).toHaveBeenCalledOnce();
  });
  it('preserves other sessions, ignores stale finish and sends Esc once to exact turn', () => {
    send('old', true);
    send('new', true);
    send('old', false);
    mock.shortcut!();
    mock.shortcut!();
    expect(mock.owner.send).toHaveBeenCalledTimes(1);
    expect(mock.owner.send).toHaveBeenCalledWith('desktop-control-cancel', {
      sessionId: 's',
      token: 'new',
      active: true,
    });
    send('other', true, 'other');
    send('other', false, 'other');
    expect(mock.windows[0].destroyed).toBe(false);
    send('new', false);
    expect(mock.windows[0].hide).toHaveBeenCalled();
  });
  it('rejects nonapplication senders and clears on transport disconnect', () => {
    mock.handlers.get('desktop-control-state')!(
      { sender: { id: 2 } },
      { sessionId: 's', token: 'bad', active: true }
    );
    expect(mock.windows).toHaveLength(0);
    send('one', true);
    mock.handlers.get('desktop-control-state')!({ sender: mock.owner }, null);
    expect(mock.windows[0].destroyed).toBe(true);
  });
  it('keeps Escape armed across chat navigation but clears on a document reload', () => {
    send('one', true);
    const navigation = mock.owner.on.mock.calls.find(([name]) => name === 'did-start-navigation')![1];
    navigation({ isMainFrame: true, isSameDocument: true });
    navigation({ isMainFrame: false, isSameDocument: false });
    expect(mock.windows[0].destroyed).toBe(false);
    mock.shortcut!();
    expect(mock.owner.send).toHaveBeenCalledWith('desktop-control-cancel', {
      sessionId: 's', token: 'one', active: true,
    });
    navigation({ isMainFrame: true, isSameDocument: false });
    expect(mock.windows[0].destroyed).toBe(true);
  });
});
