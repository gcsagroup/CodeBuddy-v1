import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  handle: vi.fn(),
  from: vi.fn(),
  getPath: vi.fn(),
  open: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: hooks.getPath },
  BrowserWindow: { fromWebContents: hooks.from },
  ipcMain: { handle: hooks.handle },
  shell: { openPath: hooks.open },
}));
import { registerPastedTextOpen } from './pastedTextMain';

it('opens an exact UTF-8 TXT copy only from the app frame without accepting renderer destinations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-paste-open-test-'));
  try {
    const sender = { mainFrame: {} };
    hooks.from.mockReturnValue({ webContents: sender });
    hooks.getPath.mockReturnValue(root);
    hooks.open.mockResolvedValue('');
    registerPastedTextOpen();
    const handler = hooks.handle.mock.calls.find(([channel]) => channel === 'open-pasted-text')![1];
    const text = '中文🙂\r\n[link](file.txt)\n' + 'x'.repeat(400000);
    expect(await handler({ sender, senderFrame: sender.mainFrame }, text)).toEqual({
      opened: true,
    });
    const opened = hooks.open.mock.calls[0][0];
    expect(path.basename(opened)).toBe('pasted-text.txt');
    expect(path.dirname(path.dirname(opened))).toBe(root);
    expect(await fs.readFile(opened, 'utf8')).toBe(text);
    await expect(handler({ sender, senderFrame: {} }, text)).rejects.toThrow('main frame');
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, { path: '../outside.exe', text })
    ).rejects.toThrow('Invalid');
    expect(hooks.open).toHaveBeenCalledTimes(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
