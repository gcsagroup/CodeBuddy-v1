import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PanelMediaRegistry, mediaRange } from './workspacePanelMedia';
import { readPanelFile, savePanelFile } from './workspacePanelFiles';

let root: string;
it('publishes correct whole, bounded, open-ended and suffix byte ranges for video seeking', () => {
  expect(mediaRange(null, 100)).toMatchObject({ status: 200, length: 100 });
  expect(mediaRange('bytes=20-29', 100)).toEqual({ status: 206, start: 20, end: 29, length: 10 });
  expect(mediaRange('bytes=80-', 100)).toEqual({ status: 206, start: 80, end: 99, length: 20 });
  expect(mediaRange('bytes=-10', 100)).toEqual({ status: 206, start: 90, end: 99, length: 10 });
  expect(mediaRange('bytes=80-200', 100)).toMatchObject({ status: 206, end: 99 });
  for (const value of [
    'bytes=100-',
    'bytes=3-2',
    'bytes=-0',
    'bytes=-',
    'bytes=1-2,4-5',
    'bytes=99999999999999999-',
  ])
    expect(mediaRange(value, 100)).toEqual({ status: 416 });
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-media-'));
});
afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

it('streams media larger than text limits without base64 IPC and keeps it read-only', async () => {
  await fs.writeFile(path.join(root, '视频.mp4'), Buffer.alloc(3 * 1024 * 1024));
  const document = await readPanelFile(root, '视频.mp4');
  expect(document.media).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
  expect(document.content).toBe('');
  await expect(savePanelFile(root, '视频.mp4', 'overwrite', '')).rejects.toThrow('read-only');
  const registry = new PanelMediaRegistry();
  const url = registry.grant(1, root, '视频.mp4');
  expect(url).not.toContain('视频');
  expect((await registry.resolve(url)).url).toMatch(/^file:/);
  expect(registry.grant(1, root, '视频.mp4')).toBe(url);
  const other = registry.grant(2, root, '视频.mp4');
  registry.revoke(1);
  await expect(registry.resolve(url)).rejects.toThrow('expired');
  await expect(registry.resolve(other)).resolves.toMatchObject({ mimeType: 'video/mp4' });
});

it('keeps an external media capability bound to one canonical file and revokes it', async () => {
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-media-reference-'));
  try {
    const file = path.join(other, 'video.mp4');
    await fs.writeFile(file, 'video');
    await fs.symlink(
      other,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const registry = new PanelMediaRegistry();
    const url = registry.grant(99, root, 'linked/video.mp4', await fs.realpath(file));
    expect((await registry.resolve(url)).mimeType).toBe('video/mp4');
    await expect(registry.resolve(registry.grant(99, root, 'linked/video.mp4'))).rejects.toThrow(
      'outside'
    );
    registry.revoke(99);
    await expect(registry.resolve(url)).rejects.toThrow('expired');
    await expect(savePanelFile(root, file, 'changed', '')).rejects.toThrow('outside');
    expect(await fs.readFile(file, 'utf8')).toBe('video');
  } finally {
    await fs.rm(other, { recursive: true, force: true });
  }
});

it('rejects missing, traversal, unsupported, oversized and swapped links on each request', async () => {
  const registry = new PanelMediaRegistry();
  for (const file of ['missing.mp4', '../outside.mp4']) {
    await expect(registry.resolve(registry.grant(1, root, file))).rejects.toThrow();
  }
  await fs.writeFile(path.join(root, 'run.html'), '<script>test</script>');
  await expect(registry.resolve(registry.grant(1, root, 'run.html'))).rejects.toThrow(
    'Unsupported'
  );
  const handle = await fs.open(path.join(root, 'huge.mp4'), 'w');
  await handle.truncate(128 * 1024 * 1024 + 1);
  await handle.close();
  await expect(readPanelFile(root, 'huge.mp4')).rejects.toThrow('size limit');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-media-outside-'));
  try {
    await fs.mkdir(path.join(root, 'inside'));
    await fs.writeFile(path.join(root, 'inside', 'a.png'), 'inside');
    await fs.writeFile(path.join(outside, 'a.png'), 'outside');
    const link = path.join(root, 'link');
    await fs.symlink(
      path.join(root, 'inside'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const url = registry.grant(1, root, 'link/a.png');
    await expect(registry.resolve(url)).resolves.toMatchObject({ mimeType: 'image/png' });
    await fs.rm(link, { force: true });
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(registry.resolve(url)).rejects.toThrow('outside');
    await fs.rm(link, { force: true });
  } finally {
    await fs.rm(outside, { force: true, recursive: true });
  }
});
