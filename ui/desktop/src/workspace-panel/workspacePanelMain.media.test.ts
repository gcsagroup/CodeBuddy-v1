import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ ipc: vi.fn(), fetch: vi.fn(), from: vi.fn() }));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: hooks.from },
  ipcMain: { handle: hooks.ipc },
  net: { fetch: hooks.fetch },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  shell: {},
  WebContentsView: vi.fn(),
}));
import { registerWorkspaceMediaSession, registerWorkspacePanel, reserveWorkspaceUpdate } from './workspacePanelMain';

it('serves verified files through the actual protocol handler with valid seek responses and owner revocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-media-protocol-'));
  try {
    const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    await fs.writeFile(path.join(root, 'clip.mp4'), bytes);
    const session = { protocol: { handle: vi.fn() } };
    registerWorkspaceMediaSession(session as never);
    expect(session.protocol.handle).toHaveBeenCalledOnce();
    const handler = session.protocol.handle.mock.calls[0][1];
    hooks.fetch.mockImplementation(async (url, options) => {
      const data = await fs.readFile(fileURLToPath(url));
      const range = /bytes=(\d+)-(\d+)/.exec(options.headers.Range || '');
      // Electron file fetch returns partial bytes with status 200 and no range headers.
      return new Response(range ? data.subarray(Number(range[1]), Number(range[2]) + 1) : data);
    });
    const wc = Object.assign(new EventEmitter(), { id: 77, session, mainFrame: {} });
    const win = Object.assign(new EventEmitter(), { webContents: wc });
    hooks.from.mockReturnValue(win);
    registerWorkspacePanel();
    const ipc = hooks.ipc.mock.calls.find(([name]) => name === 'workspace-panel')![1];
    const releaseUpdate = reserveWorkspaceUpdate();
    try {
      await expect(ipc({ sender: wc, senderFrame: wc.mainFrame }, {
        scope: { sessionId: 'one', root }, action: 'terminal-create',
      })).rejects.toThrow('准备更新');
      expect(() => reserveWorkspaceUpdate()).toThrow();
    } finally { releaseUpdate(); }
    const reply = await ipc(
      { sender: wc, senderFrame: wc.mainFrame },
      {
        scope: { sessionId: 'one', root },
        action: 'inspect',
        path: 'clip.mp4',
      }
    );
    expect(session.protocol.handle).toHaveBeenCalledOnce();
    const url = reply.file.media.url;
    for (const [range, start, end] of [
      ['bytes=20-29', 20, 29],
      ['bytes=-10', 90, 99],
      ['bytes=80-', 80, 99],
    ] as const) {
      const response = await handler(new globalThis.Request(url, { headers: { Range: range } }));
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/100`);
      expect(response.headers.get('Content-Length')).toBe(String(end - start + 1));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
    const full = await handler(new globalThis.Request(url));
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
    const head = await handler(new globalThis.Request(url, { method: 'HEAD' }));
    expect(head.headers.get('Content-Length')).toBe('100');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await handler(new globalThis.Request(url, { headers: { Range: 'bytes=100-' } }))).status).toBe(
      416
    );
    expect((await handler(new globalThis.Request(url, { method: 'POST' }))).status).toBe(405);
    win.emit('closed');
    expect((await handler(new globalThis.Request(url))).status).toBe(404);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
