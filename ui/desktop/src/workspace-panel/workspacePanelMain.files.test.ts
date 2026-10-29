import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  ipc: vi.fn(),
  from: vi.fn(),
  reveal: vi.fn(),
  copy: vi.fn(),
  open: vi.fn(),
  menu: vi.fn(),
  save: vi.fn(),
  image: vi.fn(),
  copyImage: vi.fn(),
  external: vi.fn(),
  download: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: hooks.from },
  ipcMain: { handle: hooks.ipc },
  net: {},
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  shell: { showItemInFolder: hooks.reveal, openPath: hooks.open, openExternal: hooks.external },
  clipboard: { writeText: hooks.copy, writeImage: hooks.copyImage },
  Menu: { buildFromTemplate: hooks.menu },
  dialog: { showSaveDialog: hooks.save, showMessageBox: hooks.confirm },
  nativeImage: { createFromPath: hooks.image },
  WebContentsView: vi.fn(),
}));
import { registerWorkspacePanel } from './workspacePanelMain';

it('confirms each external source preview and never grants workspace read or write access', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-reference-'));
  const root = path.join(base, 'workspace');
  try {
    await fs.mkdir(root);
    const outside = path.join(base, 'source.mjs');
    await fs.writeFile(outside, 'export const verified = true;');
    const wc = Object.assign(new EventEmitter(), {
      id: 1878,
      mainFrame: {},
      session: { protocol: { handle: vi.fn() } },
    });
    const win = Object.assign(new EventEmitter(), { webContents: wc });
    hooks.from.mockReturnValue(win);
    registerWorkspacePanel();
    const ipc = hooks.ipc.mock.calls.find(([name]) => name === 'workspace-panel')![1];
    const event = { sender: wc, senderFrame: wc.mainFrame };
    const scope = { sessionId: 'external-reference', root };
    await fs.writeFile(path.join(root, 'inside.mjs'), 'export const inside = true;');
    const confirmations = hooks.confirm.mock.calls.length;
    expect(
      (await ipc(event, { scope, action: 'read-reference', path: 'inside.mjs' })).document?.content
    ).toBe('export const inside = true;');
    expect(hooks.confirm.mock.calls).toHaveLength(confirmations);
    expect(() =>
      ipc({ ...event, senderFrame: {} }, { scope, action: 'read-reference', path: '../source.mjs' })
    ).toThrow('main frame');
    hooks.confirm.mockResolvedValueOnce({ response: 1 });
    expect(await ipc(event, { scope, action: 'read-reference', path: '../source.mjs' })).toEqual(
      {}
    );
    hooks.confirm.mockResolvedValueOnce({ response: 0 });
    const reply = await ipc(event, { scope, action: 'read-reference', path: '../source.mjs' });
    expect(reply.reference).toEqual({
      path: await fs.realpath(outside),
      content: 'export const verified = true;',
    });
    expect(hooks.confirm).toHaveBeenLastCalledWith(
      win,
      expect.objectContaining({ detail: await fs.realpath(outside), cancelId: 1, defaultId: 1 })
    );
    await expect(ipc(event, { scope, action: 'read', path: '../source.mjs' })).rejects.toThrow(
      'outside'
    );
    await expect(
      ipc(event, { scope, action: 'save', path: '../source.mjs', content: 'changed', version: '' })
    ).rejects.toThrow('outside');
    expect(await fs.readFile(outside, 'utf8')).toBe('export const verified = true;');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it('reveals or copies only existing scoped files without executing them or trusting a guest frame', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-file-menu-'));
  const root = path.join(base, 'workspace');
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, '阳光 #1.png'), 'image fixture');
    await fs.writeFile(path.join(base, 'outside.png'), 'outside');
    await fs.symlink(
      base,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const wc = Object.assign(new EventEmitter(), {
      id: 878,
      mainFrame: {},
      downloadURL: hooks.download,
      session: { protocol: { handle: vi.fn() } },
    });
    const win = Object.assign(new EventEmitter(), { webContents: wc });
    hooks.from.mockReturnValue(win);
    registerWorkspacePanel();
    const ipc = hooks.ipc.mock.calls.find(([name]) => name === 'workspace-panel')![1];
    const event = { sender: wc, senderFrame: wc.mainFrame };
    const scope = { sessionId: 'file-menu', root };
    const file = await fs.realpath(path.join(root, '阳光 #1.png'));
    await ipc(event, { scope, action: 'reveal', path: '阳光 #1.png' });
    expect(hooks.reveal).toHaveBeenCalledWith(file);
    await ipc(event, { scope, action: 'copy-path', path: file });
    expect(hooks.copy).toHaveBeenCalledWith(file);
    const labels = {
      preview: 'Preview',
      'open-external': 'Open in default application',
      reveal: 'Show in folder',
      'copy-path': 'Copy file path',
      'copy-image': 'Copy image',
      'save-as': 'Save as…',
      'copy-text': 'Copy file contents',
      'image-tab': 'Open image in new tab',
      'add-to-chat': 'Add to chat',
    };
    let menu = [] as { label?: string; enabled?: boolean; click?: () => void }[];
    hooks.menu.mockImplementation((template) => {
      menu = template;
      return {
        popup: ({ callback }: { callback: () => void }) => {
          template.find((item: { label?: string }) => item.label === labels['copy-path'])?.click();
          callback();
        },
      };
    });
    expect(
      await ipc(event, { scope, action: 'file-menu', path: file, kind: 'link', labels })
    ).toEqual({ fileAction: 'copy-path' });
    expect(menu.some((item) => item.label === 'Copy image')).toBe(false);
    expect(
      await ipc(event, { scope, action: 'file-menu', path: file, kind: 'image', labels })
    ).toEqual({ fileAction: null });
    expect(menu.some((item) => item.label === 'Copy image')).toBe(true);
    expect(menu.map((item) => item.label)).toEqual([
      'Open image in new tab',
      'Add to chat',
      'Copy image',
      'Show in folder',
      'Save as…',
    ]);
    expect(menu.some((item) => item.label === 'Copy file path')).toBe(false);
    const attached = await ipc(event, { scope, action: 'attach-image', path: file });
    expect(attached.attachment).toEqual({
      name: '阳光 #1.png',
      dataUrl: `data:image/png;base64,${Buffer.from('image fixture').toString('base64')}`,
    });
    for (const name of ['slides.pptx', 'report.pdf', 'notes.docx', 'table.xlsx', 'clip.mp4']) {
      await fs.writeFile(path.join(root, name), 'file fixture');
      await ipc(event, { scope, action: 'file-menu', path: name, kind: 'link', labels });
      expect(menu.find((item) => item.label === labels['open-external'])?.enabled).toBe(true);
      expect(
        menu.some((item) =>
          ['Copy file contents', 'Copy image', 'Add to chat'].includes(item.label ?? '')
        )
      ).toBe(false);
    }
    hooks.open.mockResolvedValue('');
    await ipc(event, { scope, action: 'open-external', path: file });
    expect(hooks.open).toHaveBeenCalledWith(file);
    const bitmap = { isEmpty: () => false };
    hooks.image.mockReturnValue(bitmap);
    await ipc(event, { scope, action: 'copy-image', path: file });
    expect(hooks.copyImage).toHaveBeenCalledWith(bitmap);
    const copy = path.join(base, 'saved.png');
    hooks.save.mockResolvedValue({ canceled: false, filePath: copy });
    await ipc(event, { scope, action: 'save-as', path: file });
    expect(await fs.readFile(copy, 'utf8')).toBe('image fixture');
    hooks.save.mockResolvedValue({ canceled: true });
    await ipc(event, { scope, action: 'save-as', path: file });
    hooks.save.mockResolvedValue({ canceled: false, filePath: file });
    await ipc(event, { scope, action: 'save-as', path: file });
    expect(await fs.readFile(file, 'utf8')).toBe('image fixture');
    await fs.writeFile(path.join(root, 'run.js'), 'throw new Error("not executed")');
    await ipc(event, { scope, action: 'open-external', path: 'run.js' });
    expect(hooks.external).toHaveBeenLastCalledWith(expect.stringContaining('/run.js'));
    await expect(ipc(event, { scope, action: 'copy-image', path: 'run.js' })).rejects.toThrow(
      'supported image'
    );
    for (const name of ['run.jsx', 'run.py', 'run.bat']) {
      await fs.writeFile(path.join(root, name), 'not executed');
      await ipc(event, { scope, action: 'open-external', path: name });
      expect(hooks.external).toHaveBeenLastCalledWith(expect.stringMatching(/^vscode:\/\/file\//));
    }
    await fs.writeFile(path.join(root, '脚本 #1%.py'), 'not executed');
    await ipc(event, { scope, action: 'open-external', path: '脚本 #1%.py' });
    expect(hooks.external).toHaveBeenLastCalledWith(
      expect.stringContaining('%E8%84%9A%E6%9C%AC%20%231%25.py')
    );
    expect(hooks.open).toHaveBeenCalledTimes(1);
    await ipc(event, {
      scope,
      action: 'file-menu',
      path: 'run.js',
      kind: 'link',
      labels: { ...labels, editor: 'Open in VS Code' },
    });
    expect(menu.find((item) => item.label === 'Open in VS Code')?.enabled).toBe(true);
    expect(menu.some((item) => item.label === labels['copy-text'])).toBe(true);
    await fs.writeFile(path.join(root, 'source.ts'), 'const 中文 = 1;\r\n');
    await ipc(event, { scope, action: 'copy-text', path: 'source.ts' });
    expect(hooks.copy).toHaveBeenLastCalledWith('const 中文 = 1;\r\n');
    await expect(ipc(event, { scope, action: 'copy-text', path: file })).rejects.toThrow('as text');
    hooks.external.mockRejectedValueOnce(new Error('No associated application'));
    await expect(ipc(event, { scope, action: 'open-external', path: 'source.ts' })).rejects.toThrow(
      'No associated application'
    );
    for (const action of [
      'reveal',
      'copy-path',
      'copy-image',
      'copy-text',
      'save-as',
      'file-menu',
      'open-external',
      'attach-image',
    ]) {
      for (const requested of [
        '../outside.png',
        path.join(base, 'outside.png'),
        'linked/outside.png',
        'missing.png',
        '.',
      ]) {
        await expect(ipc(event, { scope, action, path: requested })).rejects.toThrow();
      }
      expect(() => ipc({ ...event, senderFrame: {} }, { scope, action, path: file })).toThrow(
        'main frame'
      );
      await expect(
        ipc(event, { scope: { ...scope, root: base }, action, path: 'outside.png' })
      ).rejects.toThrow('cannot switch');
    }
    expect(hooks.reveal).toHaveBeenCalledOnce();
    expect(hooks.copy).toHaveBeenCalledTimes(2);
    expect(hooks.open).toHaveBeenCalledTimes(1);
    hooks.menu.mockImplementation((template) => ({
      popup: ({ callback }: { callback: () => void }) => {
        expect(template.some((item: { label?: string }) => item.label === labels.preview)).toBe(
          false
        );
        expect(
          template.find((item: { label?: string }) => item.label === 'Close right')?.enabled
        ).toBe(false);
        template.find((item: { label?: string }) => item.label === 'Close others')?.click();
        callback();
      },
    }));
    const tabMenu = hooks.ipc.mock.calls.find(([name]) => name === 'workspace-tab-menu')![1];
    expect(
      await tabMenu(event, {
        scope,
        path: 'source.ts',
        labels,
        tabs: {
          labels: { close: 'Close', 'close-others': 'Close others', 'close-right': 'Close right' },
          others: true,
          right: false,
        },
      })
    ).toEqual({ fileAction: null, tabAction: 'close-others' });
    for (const requested of ['../outside.png', 'linked/outside.png', '.', 'missing.pdf', file]) {
      await expect(
        ipc(event, {
          scope,
          action: 'document-preview',
          path: requested,
          page: 1,
          requestId: 'preview-boundary',
        })
      ).rejects.toThrow();
    }
    for (const requestId of ['', 'x'.repeat(101), 3, {}])
      await expect(
        ipc(event, { scope, action: 'document-preview', path: 'report.pdf', requestId })
      ).rejects.toThrow('Invalid document request');
    expect(() =>
      ipc(
        { ...event, senderFrame: {} },
        { scope, action: 'document-preview', path: 'report.pdf', page: 1, requestId: 'guest' }
      )
    ).toThrow('main frame');
    await expect(ipc(event, { scope, action: 'unsupported-future-action' })).rejects.toThrow(
      'Unsupported workspace action'
    );
    const web = hooks.ipc.mock.calls.find(([name]) => name === 'web-link-menu')![1];
    const webLabels = {
      preview: 'Open in new tab',
      'open-external': 'Default browser',
      'copy-link': 'Copy link',
      'save-link': 'Save link as…',
    };
    for (const choice of Object.keys(webLabels)) {
      hooks.menu.mockImplementation((template) => ({
        popup: ({ callback }: { callback: () => void }) => {
          expect(template.map((item: { label: string }) => item.label)).toEqual(
            Object.values(webLabels)
          );
          template
            .find(
              (item: { label: string }) =>
                item.label === webLabels[choice as keyof typeof webLabels]
            )
            .click();
          callback();
        },
      }));
      expect(
        await web(event, {
          url: 'https://example.com/?a=1#part',
          allowPreview: true,
          labels: webLabels,
        })
      ).toEqual({ action: choice === 'preview' ? 'preview' : null });
    }
    expect(hooks.external).toHaveBeenCalledWith('https://example.com/?a=1#part');
    expect(hooks.download).toHaveBeenCalledWith('https://example.com/?a=1#part');
    const menuCalls = hooks.menu.mock.calls.length;
    for (const url of [
      'file:///C:/private.txt',
      'javascript:alert(1)',
      'https://user:password@example.com/',
    ]) {
      await expect(web(event, { url, allowPreview: true, labels: webLabels })).rejects.toThrow();
    }
    await expect(
      web(
        { ...event, senderFrame: {} },
        { url: 'https://example.com/', allowPreview: true, labels: webLabels }
      )
    ).rejects.toThrow('main frame');
    expect(hooks.menu).toHaveBeenCalledTimes(menuCalls);
    win.emit('closed');
  } finally {
    await fs.rm(base, { force: true, recursive: true });
  }
});
