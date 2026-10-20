import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listPanelFiles,
  inspectPanelFile,
  externalPanelDocument,
  panelPath,
  panelUrl,
  readPanelFile,
  savePanelFile,
  searchPanelFiles,
} from './workspacePanelFiles';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-panel-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe('workspace files using real filesystem data', () => {
  it('inspects large documents without reading a preview and only opens existing scoped documents', async () => {
    await fs.writeFile(path.join(root, 'report.docx'), Buffer.alloc(3 * 1024 * 1024));
    expect(await inspectPanelFile(root, 'report.docx')).toMatchObject({
      path: 'report.docx',
      size: 3 * 1024 * 1024,
      openExternally: true,
    });
    expect(await externalPanelDocument(root, 'report.docx')).toBe(
      await fs.realpath(path.join(root, 'report.docx'))
    );
    await fs.writeFile(path.join(root, 'run.ps1'), 'Write-Output hello');
    await expect(externalPanelDocument(root, 'run.ps1')).rejects.toThrow('document files only');
    await expect(inspectPanelFile(root, 'missing.docx')).rejects.toThrow();
    await expect(inspectPanelFile(root, '../outside.docx')).rejects.toThrow('outside');
    await expect(inspectPanelFile(root, '.')).rejects.toThrow('regular file');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-external-document-'));
    try {
      await fs.writeFile(path.join(outside, 'report.docx'), 'outside');
      await fs.symlink(
        outside,
        path.join(root, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await expect(externalPanelDocument(root, 'linked/report.docx')).rejects.toThrow('outside');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  it('preserves Chinese, BOM and CRLF and truncates shorter saves', async () => {
    const source = '\ufeff你好\r\nsecond line\r\n';
    await fs.writeFile(path.join(root, '中文.txt'), source);
    const original = await readPanelFile(root, '中文.txt');
    expect(original.content).toBe(source);
    const saved = await savePanelFile(root, '中文.txt', '\ufeff短\r\n', original.version);
    expect(await fs.readFile(path.join(root, '中文.txt'), 'utf8')).toBe(saved.content);
    expect(saved.version).not.toBe(original.version);
  });
  it('rejects stale saves without overwriting an external edit', async () => {
    const file = path.join(root, 'draft.txt');
    await fs.writeFile(file, 'first');
    const original = await readPanelFile(root, 'draft.txt');
    await fs.writeFile(file, 'external');
    await expect(savePanelFile(root, 'draft.txt', 'local', original.version)).rejects.toThrow(
      'changed on disk'
    );
    expect(await fs.readFile(file, 'utf8')).toBe('external');
  });
  it('serializes two writers and rejects the stale second one', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'first');
    const { version } = await readPanelFile(root, 'a.txt');
    const outcomes = await Promise.allSettled([
      savePanelFile(root, 'a.txt', 'one', version),
      savePanelFile(root, 'a.txt', 'two', version),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(
      outcomes[0].status === 'fulfilled' ? 'one' : 'two'
    );
  });
  it('rejects traversal and a junction outside the workspace', async () => {
    await expect(panelPath(root, '..')).rejects.toThrow('outside');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
      await fs.symlink(
        outside,
        path.join(root, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await expect(readPanelFile(root, 'link/secret.txt')).rejects.toThrow('outside');
      expect((await listPanelFiles(root, '')).entries[0].kind).toBe('link');
    } finally {
      await fs.rm(path.join(root, 'link'), { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  it('searches nested names and skips dependency folders', async () => {
    await fs.mkdir(path.join(root, 'folder'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'folder', '说明.md'), 'yes');
    await fs.writeFile(path.join(root, 'node_modules', '说明.md'), 'skip');
    expect((await searchPanelFiles(root, '说明')).entries.map((e) => e.path)).toEqual([
      path.join('folder', '说明.md'),
    ]);
  });
  it('keeps returned paths relative when the workspace root is a directory link', async () => {
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'workspace-link');
    await fs.mkdir(path.join(actual, 'folder'), { recursive: true });
    await fs.writeFile(path.join(actual, 'folder', 'note.txt'), 'linked workspace');
    await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await listPanelFiles(alias, '')).entries.map((entry) => entry.path)).toEqual([
      'folder',
    ]);
    const found = (await searchPanelFiles(alias, 'note')).entries[0];
    expect(found.path).toBe(path.join('folder', 'note.txt'));
    expect((await readPanelFile(alias, found.path)).content).toBe('linked workspace');
    await expect(panelPath(alias, '..')).rejects.toThrow('outside');
  });
  it('rejects binary and oversized files, previews images', async () => {
    await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([1, 0, 2]));
    const binary = await readPanelFile(root, 'data.bin');
    expect(binary.binary).toBe(true);
    await expect(savePanelFile(root, 'data.bin', 'overwrite', binary.version)).rejects.toThrow(
      'read-only'
    );
    expect(await fs.readFile(path.join(root, 'data.bin'))).toEqual(Buffer.from([1, 0, 2]));
    await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await expect(readPanelFile(root, 'large.txt')).rejects.toThrow('2 MB');
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([137, 80, 78, 71]));
    expect((await readPanelFile(root, 'image.png')).media).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
  });
  it('allows web addresses but rejects local files, scripts and URL credentials', () => {
    expect(panelUrl('example.com')).toBe('https://example.com/');
    expect(panelUrl('http://localhost:3456/')).toBe('http://localhost:3456/');
    for (const url of [
      'file:///C:/a.txt',
      'javascript:alert(1)',
      'https://user:secret@example.com',
    ])
      expect(() => panelUrl(url)).toThrow();
  });
});

it.each(['utf16le', 'utf16be'])(
  'reads and saves %s text without changing the original encoding',
  async (encoding) => {
    const bytes = Buffer.from('\ufeff中文\r\n', 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    const file = path.join(root, 'rules.txt');
    await fs.writeFile(file, bytes);
    const doc = await readPanelFile(root, 'rules.txt');
    expect(doc.binary).toBeUndefined();
    expect(doc.content).toBe('\ufeff中文\r\n');
    const saved = await savePanelFile(root, 'rules.txt', '短\r\n', doc.version);
    expect(saved.content).toBe('\ufeff短\r\n');
    const expected = Buffer.from('\ufeff短\r\n', 'utf16le');
    if (encoding === 'utf16be') expected.swap16();
    expect(await fs.readFile(file)).toEqual(expected);
  }
);
