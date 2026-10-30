import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, readFile, access, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readMediaLibrary, deleteMediaLibrary } from '../media-library.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-media-library-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = ['first', 'archived'].map(id => ({ id, name: `Chat ${id}`, cwd: path.join(root, id), archivedAt: id === 'archived' ? '2026-01-01' : null }));
  for (const session of sessions) await mkdir(session.cwd);
  async function receipt(session, kind = 'image', options = {}) {
    const id = randomUUID(), key = kind === 'image' ? 'images' : 'videos';
    const directory = path.join(root, `${kind}-jobs`, Buffer.from(session.id).toString('hex'));
    await mkdir(directory, { recursive: true });
    const output = path.join(session.cwd, `generated-${key}`, id, `1.${kind === 'image' ? 'png' : 'mp4'}`);
    await mkdir(path.dirname(output), { recursive: true });
    if (!options.missing) await writeFile(output, 'fixture');
    const job = { job_id: id, status: 'completed', created_at: '2026-10-29T00:00:00.000Z',
      input: { prompt: 'A mountain' }, server: 'private-service', [key]: [{ path: output }], ...options.job };
    const file = path.join(directory, `${id}.json`);
    await writeFile(file, options.corrupt ? '{' : JSON.stringify(job));
    return { file, output, job };
  }
  return { root, sessions, receipt };
}

test('lists all project sessions including archived chats, both types and every output without exposing server settings', async t => {
  const f = await fixture(t);
  const image = await f.receipt(f.sessions[0]);
  await writeFile(image.file, JSON.stringify({ ...image.job, images: [image.job.images[0], { path: image.output.replace('1.png', '2.png') }] }));
  await f.receipt(f.sessions[1], 'video');
  await f.receipt(f.sessions[0], 'image', { job: { status: 'running' } });
  const result = await readMediaLibrary(f.root, f.sessions);
  assert.equal(result.total, 3);
  assert.equal(result.items.filter(item => item.available).length, 2);
  assert.equal(result.projects.length, 2);
  assert.equal(result.items.some(item => item.sessionId === 'archived'), true);
  assert.equal(JSON.stringify(result).includes('private-service'), false);
});

test('pagination includes receipts older than the per-session twenty-job preview limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 51; i++) await f.receipt(f.sessions[0]);
  const first = await readMediaLibrary(f.root, f.sessions);
  const next = await readMediaLibrary(f.root, f.sessions, { cursor: first.nextCursor });
  assert.equal(first.total, 51);
  assert.equal(first.items.length, 48);
  assert.equal(next.items.length, 3);
  assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 51);
});

test('type, project and search filters combine without losing the full project selector', async t => {
  const f = await fixture(t);
  await f.receipt(f.sessions[0]);
  await f.receipt(f.sessions[1], 'video');
  const result = await readMediaLibrary(f.root, f.sessions, { kind: 'video', project: f.sessions[1].cwd, search: 'MOUNTAIN' });
  assert.equal(result.total, 1);
  assert.equal(result.projects.length, 2);
  await assert.rejects(readMediaLibrary(f.root, f.sessions, { kind: 'audio' }), /filter/);
});

test('missing files remain discoverable and corrupt or out-of-workspace receipts do not poison the list', async t => {
  const f = await fixture(t);
  await f.receipt(f.sessions[0], 'image', { missing: true });
  await f.receipt(f.sessions[0], 'image', { corrupt: true });
  await f.receipt(f.sessions[0], 'image', { job: { images: [{ path: path.join(f.root, 'outside.png') }] } });
  const result = await readMediaLibrary(f.root, f.sessions);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].available, false);
  assert.equal(result.unreadableRecords, 2);
});

test('receipt directory links outside the data root are not followed', async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-media-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(f.root, 'image-jobs'));
  await symlink(outside, path.join(f.root, 'image-jobs', Buffer.from(f.sessions[0].id).toString('hex')), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readMediaLibrary(f.root, f.sessions);
  assert.equal(result.total, 0);
  assert.equal(result.unreadableRecords, 1);
});

test('sizes cover all pages and workspace pagination preserves newest-first order within each workspace', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 51; i++) await f.receipt(f.sessions[i % 2], i % 2 ? 'video' : 'image', { job: { created_at: new Date(1700000000000 + i * 1000).toISOString() } });
  await f.receipt(f.sessions[0], 'image', { missing: true });
  const first = await readMediaLibrary(f.root, f.sessions, { view: 'workspace' });
  const last = await readMediaLibrary(f.root, f.sessions, { view: 'workspace', cursor: first.nextCursor });
  assert.equal(first.totalBytes, 51 * 7);
  assert.equal(first.libraryBytes, 51 * 7);
  assert.equal(first.projectStats.reduce((sum, group) => sum + group.sizeBytes, 0), 51 * 7);
  const all = [...first.items, ...last.items];
  assert.equal(new Set(all.map(item => item.id)).size, 52);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].root <= all[i].root);
    if (all[i - 1].root === all[i].root) assert.ok(all[i - 1].createdAt >= all[i].createdAt);
  }
  const videos = await readMediaLibrary(f.root, f.sessions, { kind: 'video' });
  assert.equal(videos.totalBytes, 25 * 7);
  assert.equal(videos.libraryBytes, 51 * 7);
});

test('confirmed batch deletion removes only selected outputs, persists hidden IDs and is retry-safe', async t => {
  const f = await fixture(t);
  const selected = await f.receipt(f.sessions[0]);
  const kept = await f.receipt(f.sessions[1], 'video');
  await f.receipt(f.sessions[0], 'image', { missing: true });
  const store = await openStore(f.root);
  await store.update(state => { state.sessions = f.sessions; });
  const original = await readFile(selected.file, 'utf8');
  const list = await readMediaLibrary(f.root, f.sessions);
  const ids = list.items.filter(item => item.kind === 'image').map(item => item.id);
  await assert.rejects(deleteMediaLibrary(store, { ids }), /Confirm/);
  await access(selected.output);
  const result = await deleteMediaLibrary(store, { ids: [...ids, 'untrusted/path'], confirm: true });
  assert.equal(result.results.filter(item => item.deleted).length, 2);
  assert.equal(result.results.filter(item => !item.deleted).length, 1);
  await assert.rejects(access(selected.output), { code: 'ENOENT' });
  await access(kept.output);
  assert.equal(await readFile(selected.file, 'utf8'), original, 'generation receipts are not rewritten');
  const reopened = await openStore(f.root);
  const after = await readMediaLibrary(f.root, f.sessions, {}, reopened.read(['mediaLibraryDeleted']).mediaLibraryDeleted);
  assert.equal(after.total, 1);
  assert.equal(after.totalBytes, 7);
  assert.ok((await deleteMediaLibrary(store, { ids, confirm: true })).results.every(item => item.deleted));
});

test('deletion refuses a junction into another generated directory and reports partial success', async t => {
  const f = await fixture(t);
  const unsafe = await f.receipt(f.sessions[0]);
  const safe = await f.receipt(f.sessions[1]);
  const directory = path.dirname(unsafe.output), moved = directory + '-moved';
  await rename(directory, moved);
  await symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const store = await openStore(f.root);
  await store.update(state => { state.sessions = f.sessions; });
  const list = await readMediaLibrary(f.root, f.sessions);
  const result = await deleteMediaLibrary(store, { ids: list.items.map(item => item.id), confirm: true });
  assert.equal(result.results.filter(item => item.deleted).length, 1);
  assert.match(result.results.find(item => !item.deleted).error, /Linked/);
  await access(path.join(moved, '1.png'));
  await assert.rejects(access(safe.output), { code: 'ENOENT' });
});

test('compatibility endpoints expose sizes and consistently hide deleted outputs', async t => {
  const f = await fixture(t);
  await f.receipt(f.sessions[0]);
  const store = await openStore(f.root);
  await store.update(state => { state.sessions = f.sessions; });
  const host = new Compat(store, { close: async () => {} });
  try {
    const before = await host.request('_codebuddy/media/library', { view: 'workspace' });
    assert.equal(before.libraryBytes, 7);
    await host.request('_codebuddy/media/delete', { ids: [before.items[0].id], confirm: true });
    const after = await host.request('_codebuddy/media/library', {});
    assert.equal(after.total, 0);
    assert.equal(after.libraryBytes, 0);
  } finally { await host.close(); }
});


test('full selection spans pages and refreshed metadata reflects file growth, removal and changed receipts', async t => {
  const f = await fixture(t);
  const first = await f.receipt(f.sessions[0]);
  for (let i = 0; i < 50; i++) await f.receipt(f.sessions[0]);
  const before = await readMediaLibrary(f.root, f.sessions);
  assert.equal(before.libraryCount, 51);
  assert.equal(before.libraryBytes, 51 * 7);
  await writeFile(first.output, Buffer.alloc(2048));
  const selection = await readMediaLibrary(f.root, f.sessions, { all: true, project: f.sessions[0].cwd });
  assert.equal(selection.items.length, 51);
  assert.equal(selection.nextCursor, null);
  assert.equal(selection.libraryBytes, 50 * 7 + 2048);
  await rm(first.output);
  const missing = await readMediaLibrary(f.root, f.sessions);
  assert.equal(missing.libraryBytes, 50 * 7);
  await writeFile(first.file, JSON.stringify({ ...first.job, status: 'failed' }));
  const changed = await readMediaLibrary(f.root, f.sessions);
  assert.equal(changed.libraryCount, 50);
  await assert.rejects(readMediaLibrary(f.root, f.sessions, { all: 'yes' }), /filter/);
});
