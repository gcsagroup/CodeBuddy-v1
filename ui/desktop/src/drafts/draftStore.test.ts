import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore } from './draftStore';

describe('persistent new-task drafts', () => {
  let root: string;
  let store: DraftStore;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-drafts-'));
    store = new DraftStore(path.join(root, 'drafts'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('restores exact text, folder, image contents and file copies after a process restart', async () => {
    const source = path.join(root, '中文 [1].txt');
    await writeFile(source, 'original attachment bytes');
    await store.request(11, {
      action: 'update',
      key: 'codepro',
      patch: {
        text: '  中文 🙂\nsecond line  ',
        workingDir: root,
        permissionPreset: 'danger-full-access',
        images: [{ id: 'clipboard', dataUrl: 'data:image/png;base64,YQ==', isLoading: false }],
        files: [
          {
            id: 'file-1',
            path: source,
            name: '中文 [1].txt',
            type: 'text/plain',
            isImage: false,
            isVideo: false,
          },
        ],
      },
    });
    await rm(source);
    const restored = await new DraftStore(path.join(root, 'drafts')).request(99, {
      action: 'read',
    });
    expect(restored.codepro?.text).toBe('  中文 🙂\nsecond line  ');
    expect(restored.codepro?.workingDir).toBe(root);
    expect(restored.codepro?.permissionPreset).toBe('danger-full-access');
    expect(restored.code?.permissionPreset).toBeUndefined();
    expect(restored.codepro?.images?.[0].dataUrl).toBe('data:image/png;base64,YQ==');
    expect(await readFile(restored.codepro!.files![0].path, 'utf8')).toBe(
      'original attachment bytes'
    );
  });

  it('isolates windows and modes and reclaims the closed window slot', async () => {
    await store.request(1, { action: 'update', key: 'code', patch: { text: 'ordinary' } });
    await store.request(1, { action: 'update', key: 'codepro', patch: { text: 'first' } });
    await store.request(2, { action: 'update', key: 'codepro', patch: { text: 'second' } });
    expect((await store.request(1, { action: 'read' })).codepro?.text).toBe('first');
    expect((await store.request(2, { action: 'read' })).codepro?.text).toBe('second');
    store.release(1);
    const restored = await store.request(3, { action: 'read' });
    expect(restored.code?.text).toBe('ordinary');
    expect(restored.codepro?.text).toBe('first');
  });

  it('orders rapid typing and Send clearing, without resurrecting attachments after restart', async () => {
    const updates = Array.from({ length: 30 }, (_, i) =>
      store.request(1, { action: 'update', key: 'codepro', patch: { text: `draft-${i}` } })
    );
    const clear = store.request(1, { action: 'clear', key: 'codepro' });
    await Promise.all([...updates, clear, store.flush()]);
    expect(
      (await new DraftStore(path.join(root, 'drafts')).request(1, { action: 'read' })).codepro
    ).toEqual({ text: '', workingDir: '', files: [], images: [], permissionPreset: null });
  });

  it('copies attachments only once and text edits do not rewrite image data', async () => {
    const source = path.join(root, 'file.txt');
    await writeFile(source, 'first');
    const attachment = {
      id: 'same-id',
      path: source,
      name: 'file.txt',
      type: 'text/plain',
      isImage: false,
      isVideo: false,
    };
    await store.request(1, { action: 'update', key: 'codepro', patch: { files: [attachment] } });
    await writeFile(source, 'changed');
    await store.request(1, {
      action: 'update',
      key: 'codepro',
      patch: { files: [attachment], text: 'typed' },
    });
    const restored = (await store.request(1, { action: 'read' })).codepro!;
    expect(await readFile(restored.files![0].path, 'utf8')).toBe('first');
    await expect(
      readFile(path.join(root, 'drafts/window-1/codepro/images.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the last saved files if a new attachment cannot be copied and remains usable', async () => {
    await store.request(1, {
      action: 'update',
      key: 'codepro',
      patch: { files: [], text: 'keep' },
    });
    await expect(
      store.request(1, {
        action: 'update',
        key: 'codepro',
        patch: {
          files: [
            {
              id: 'missing',
              path: path.join(root, 'missing'),
              name: 'missing',
              type: '',
              isImage: false,
              isVideo: false,
            },
          ],
        },
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.request(1, { action: 'read' })).codepro).toMatchObject({
      files: [],
      text: 'keep',
    });
  });

  it('reports corrupted storage and invalid IPC without overwriting saved data', async () => {
    await store.request(1, { action: 'update', key: 'codepro', patch: { text: 'keep' } });
    const saved = path.join(root, 'drafts/window-1/codepro/text.json');
    await writeFile(saved, 'bad json');
    await expect(store.request(1, { action: 'read' })).rejects.toThrow();
    expect(await readFile(saved, 'utf8')).toBe('bad json');
    expect(() => store.request(1, { action: 'clear', key: '../outside' } as never)).toThrow();
  });

  it('restores interrupted previews as an actionable error instead of an endless spinner', async () => {
    await store.request(1, {
      action: 'update',
      key: 'codepro',
      patch: { images: [{ id: 'pending', dataUrl: '', isLoading: true }] },
    });
    const restored = (await store.request(1, { action: 'read' })).codepro!.images![0];
    expect(restored.isLoading).toBe(false);
    expect(restored.error).toContain('interrupted');
  });
});
