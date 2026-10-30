import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen, type WebContents } from 'electron';
import { createDesktopEscape } from './desktopControlKeyboard';
import { applicationWindows, markAuxiliaryWindow } from './pets/petMain';
import { parseDesktopControl, type DesktopControlState } from './desktopControl';
import { desktopFeedbackDocument } from './desktopFeedbackDocument';

// Only projects live runtime events. This window never declares completion or sends input.
export function registerDesktopControl() {
  const active = new Map<string, { owner: WebContents; state: DesktopControlState }>();
  const observed = new Set<number>();
  const overlays = new Map<number, BrowserWindow>();
  const loaded = new WeakSet<BrowserWindow>();
  let escapeReady = false;
  let cancelling: string | undefined;
  let pointerTimer: ReturnType<typeof setInterval> | undefined;
  const pointerFrames = new Map<number, string>();
  const pendingFrames = new WeakSet<BrowserWindow>();
  const drawPointer = () => {
    if (!active.size) return;
    const point = screen.getCursorScreenPoint();
    for (const [id, overlay] of overlays) {
      if (overlay.isDestroyed() || pendingFrames.has(overlay)) continue;
      const bounds = overlay.getBounds();
      const x = point.x - bounds.x,
        y = point.y - bounds.y;
      const visible = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      const frame = visible ? `${x},${y},${bounds.width},${bounds.height}` : 'hidden';
      if (pointerFrames.get(id) === frame) continue;
      pendingFrames.add(overlay);
      // At most one renderer update per display in flight; never await drawing
      // on the tool path. Coordinates and bounds are in Electron's DIP space.
      void overlay.webContents
        .executeJavaScript(
          `(() => {const p=document.getElementById('pointer');if(!p)return false;p.style.display=${JSON.stringify(visible ? 'block' : 'none')};p.style.transform='translate3d(${x - 2}px,${y - 2}px,0)';const label=p.querySelector('.cursor-label');label.style.left=${JSON.stringify(x > bounds.width - 110 ? '-70px' : '16px')};label.style.top=${JSON.stringify(y > bounds.height - 65 ? '-24px' : '32px')};return true;})()`
        )
        .then((ready) => {
          if (ready && overlays.get(id) === overlay) pointerFrames.set(id, frame);
        })
        .catch(() => {})
        .finally(() => pendingFrames.delete(overlay));
    }
  };
  const updateHint = () => {
    for (const overlay of overlays.values()) {
      if (overlay.isDestroyed()) continue;
      void overlay.webContents
        .executeJavaScript(
          `document.querySelector('.hint').textContent=${JSON.stringify(escapeReady ? 'Esc 停止电脑控制' : '在对话中停止电脑控制')}`
        )
        .catch(() => {});
    }
  };
  const keyboard = createDesktopEscape(
    (token) => {
      const current = [...active.values()].find((value) => value.state.token === token);
      if (!current || current.owner.isDestroyed() || cancelling === token) return;
      cancelling = token;
      current.owner.send('desktop-control-cancel', current.state);
    },
    (ready) => {
      if (escapeReady === ready) return;
      escapeReady = ready;
      updateHint();
    },
    process.platform === 'darwin'
      ? path.join(app.isPackaged
          ? path.join(process.resourcesPath, 'harness-distribution')
          : path.resolve(app.getAppPath(), '../..'), 'runtime/tools/bin/qwen-computer-runtime')
      : undefined
  );
  const hide = () => {
    if (overlays.size) console.info('[Desktop feedback] hidden', { displays: overlays.size });
    if (pointerTimer) clearInterval(pointerTimer);
    pointerTimer = undefined;
    pointerFrames.clear();
    keyboard.arm('');
    escapeReady = false;
    for (const overlay of overlays.values()) if (!overlay.isDestroyed()) overlay.hide();
    cancelling = undefined;
  };
  const dispose = () => {
    hide();
    for (const overlay of overlays.values()) if (!overlay.isDestroyed()) overlay.destroy();
    overlays.clear();
  };
  app.once('will-quit', () => { dispose(); keyboard.close(); });
  const syncDisplays = () => {
    if (!active.size) return;
    const displays = screen.getAllDisplays();
    for (const [id, overlay] of overlays) {
      if (!displays.some((display) => display.id === id)) {
        if (!overlay.isDestroyed()) overlay.destroy();
        overlays.delete(id);
      }
    }
    for (const display of displays) {
      const existing = overlays.get(display.id);
      if (existing && !existing.isDestroyed()) {
        const old = existing.getBounds();
        const next = display.bounds;
        if (
          old.x !== next.x ||
          old.y !== next.y ||
          // Fractional Windows scale factors can round a window size by one DIP.
          Math.abs(old.width - next.width) > 1 ||
          Math.abs(old.height - next.height) > 1
        )
          existing.setBounds(next);
        if (loaded.has(existing) && !existing.isVisible()) existing.showInactive();
        continue;
      }
      // Fixed surfaces; only the small pointer changes while control is active.
      const current = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        transparent: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        enableLargerThanScreen: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      overlays.set(display.id, current);
      markAuxiliaryWindow(current);
      current.setIgnoreMouseEvents(true);
      current.setAlwaysOnTop(true, 'screen-saver');
      current.setContentProtection(true);
      const hint = escapeReady ? 'Esc 停止电脑控制' : '在对话中停止电脑控制';
      void current
        .loadURL(
          'data:text/html;charset=utf-8,' + encodeURIComponent(desktopFeedbackDocument(hint))
        )
        .then(() => {
          if (overlays.get(display.id) !== current || current.isDestroyed()) return;
          // Native window discovery ignores untitled presentation surfaces.
          // Do not expose another apparent CodeBuddy target to the agent.
          current.setTitle('');
          loaded.add(current);
          // Windows may constrain initial creation to the primary work area before
          // the target display DPI is known. Reapply current DIP bounds after load.
          const target = screen.getAllDisplays().find((item) => item.id === display.id);
          if (target) current.setBounds(target.bounds);
          updateHint();
          if (!active.size) return;
          current.showInactive();
          console.info('[Desktop feedback] shown', { displayId: display.id, bounds: current.getBounds(), visible: current.isVisible() });
          pointerFrames.delete(display.id);
          drawPointer();
        })
        .catch((error) => {
          if (current.isDestroyed() || overlays.get(display.id) !== current) return;
          console.error('[Desktop feedback] window load failed', error);
          for (const owner of new Set([...active.values()].map(value => value.owner)))
            if (!owner.isDestroyed()) owner.send('desktop-control-feedback-error', '电脑控制提示层加载失败；请以会话中的控制状态为准。');
          if (overlays.get(display.id) === current) {
            overlays.delete(display.id);
            if (!current.isDestroyed()) current.destroy();
          }
        });
    }
  };
  screen.on('display-added', syncDisplays);
  screen.on('display-removed', syncDisplays);
  screen.on('display-metrics-changed', syncDisplays);
  const show = () => {
    if (!active.size) {
      hide();
      return;
    }
    const entries = [...active.values()];
    keyboard.arm(entries[entries.length - 1].state.token);
    syncDisplays();
    if (!pointerTimer) pointerTimer = setInterval(drawPointer, 33);
  };
  ipcMain.on('desktop-control-state', (event, input) => {
    if (!applicationWindows().some((window) => window.webContents === event.sender)) return;
    const id = event.sender.id;
    const clear = () => {
      for (const [key, value] of active) if (value.owner.id === id) active.delete(key);
      if (!active.size) dispose(); else show();
    };
    if (input === null) {
      clear();
      return;
    }
    const state = parseDesktopControl(input?.sessionId, { ...input, event: 'desktop_control' });
    if (!state || typeof state.sessionId !== 'string' || !state.sessionId) return;
    console.info('[Desktop feedback] state received', { sessionId: state.sessionId, active: state.active });
    if (!observed.has(id)) {
      observed.add(id);
      event.sender.on('render-process-gone', clear);
      // Hash/history navigation switches chats without replacing the renderer.
      // Keep the active lease's Escape listener and feedback across that switch.
      event.sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) clear();
      });
      event.sender.once('destroyed', () => {
        clear();
        observed.delete(id);
      });
    }
    const key = JSON.stringify([id, state.sessionId]);
    if (state.active) {
      active.delete(key);
      active.set(key, { owner: event.sender, state });
      cancelling = undefined;
    } else if (active.get(key)?.state.token === state.token) active.delete(key);
    show();
  });
}
