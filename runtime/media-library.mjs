import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const orderKey = item => `${item.createdAt}\0${item.id}`;

// Cache only parsed receipts, never file sizes: external changes are visible on refresh.
const receiptCache = new Map();
let receiptCacheBytes = 0;
async function scanMediaLibrary(dataDir, sessions, deleted = []) {
  const hidden = new Set(deleted);
  const items = [];
  let unreadableRecords = 0;
  const root = await realpath(dataDir);
  const workspaceCache = new Map();
  const fileCache = new Map();
  for (const session of sessions) {
    if (typeof session.id !== 'string' || typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd)) continue;
    for (const mediaKind of ['image', 'video']) {
      const directory = path.join(root, `${mediaKind}-jobs`, Buffer.from(session.id).toString('hex'));
      let files;
      try {
        if (!inside(root, await realpath(directory))) throw new Error('Receipt directory outside data root');
        files = await readdir(directory);
      } catch (error) {
        if (error.code !== 'ENOENT') unreadableRecords++;
        continue;
      }
      let nextFile = 0;
      // Bound metadata I/O so large single-session libraries do not scan serially.
      await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (nextFile < files.length) {
        const name = files[nextFile++];
        if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) continue;
        try {
          const receipt = path.join(directory, name);
          const info = await lstat(receipt);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Invalid receipt');
          const signature = [info.size, info.mtimeMs, info.ctimeMs, info.ino].join(':');
          const cached = receiptCache.get(receipt);
          const job = cached?.signature === signature ? cached.job : JSON.parse(await readFile(receipt, 'utf8'));
          if (cached?.signature !== signature) {
            if (cached) { receiptCacheBytes -= cached.size; receiptCache.delete(receipt); }
            while (receiptCache.size && (receiptCache.size >= 4096 || receiptCacheBytes + info.size > 32 * 1024 * 1024)) {
              const oldest = receiptCache.keys().next().value;
              receiptCacheBytes -= receiptCache.get(oldest).size;
              receiptCache.delete(oldest);
            }
            receiptCache.set(receipt, { signature, job, size: info.size });
            receiptCacheBytes += info.size;
          }
          if (job.job_id !== name.slice(0, -5)) throw new Error('Receipt identity mismatch');
          if (job.status !== 'completed') continue;
          if (typeof job.created_at !== 'string' || !Number.isFinite(Date.parse(job.created_at))) throw new Error('Invalid receipt date');
          const outputs = job[mediaKind === 'image' ? 'images' : 'videos'];
          if (!Array.isArray(outputs)) throw new Error('Invalid outputs');
          if (!workspaceCache.has(session.cwd)) workspaceCache.set(session.cwd, realpath(session.cwd).catch(() => path.resolve(session.cwd)));
          const workspace = await workspaceCache.get(session.cwd);
          const expected = path.join(workspace, mediaKind === 'image' ? 'generated-images' : 'generated-videos', job.job_id);
          for (const [index, output] of outputs.entries()) {
            if (typeof output.path !== 'string' || !path.isAbsolute(output.path) ||
                !inside(expected, output.path) || path.extname(output.path).toLowerCase() !== (mediaKind === 'image' ? '.png' : '.mp4')) {
              unreadableRecords++;
              continue;
            }
            const id = `${session.id}:${job.job_id}:${index}`;
            if (hidden.has(id)) continue;
            const fileKey = process.platform === 'win32' ? path.resolve(output.path).toLowerCase() : path.resolve(output.path);
            if (!fileCache.has(fileKey)) fileCache.set(fileKey, (async () => {
              try {
                const actualFile = await realpath(output.path);
                const stat = await lstat(actualFile);
                const available = inside(workspace, actualFile) && stat.isFile();
                return { available, sizeBytes: available ? stat.size : 0 };
              } catch { return { available: false, sizeBytes: 0 }; }
            })());
            const { available, sizeBytes } = await fileCache.get(fileKey);
            items.push({
              id, sizeBytes, sessionId: session.id,
              sessionName: session.name || session.title || session.id, root: workspace,
              kind: mediaKind, path: output.path, filename: path.basename(output.path), available,
              createdAt: new Date(job.created_at).toISOString(),
              displayName: typeof job.display_name === 'string' ? job.display_name.trim().slice(0, 160) : '',
              prompt: typeof job.input?.prompt === 'string' ? job.input.prompt.slice(0, 12000) : '',
            });
          }
        } catch { unreadableRecords++; }
      }
      }));
    }
  }
  return { items, unreadableRecords };
}

const bytes = items => [...new Map(items.filter(item => item.available).map(item => [process.platform === 'win32' ? path.resolve(item.path).toLowerCase() : path.resolve(item.path), item.sizeBytes])).values()].reduce((sum, value) => sum + value, 0);
export async function readMediaLibrary(dataDir, sessions, query = {}, deleted = []) {
  const { kind = 'all', project = '', search = '', cursor = '', view = 'time', all = false } = query;
  if (typeof all !== 'boolean' || !['all', 'image', 'video'].includes(kind) || !['time', 'workspace'].includes(view) ||
      [project, search, cursor].some(value => typeof value !== 'string' || value.length > 8192))
    throw Object.assign(new Error('Invalid media library filter'), { code: -32602 });
  const { items, unreadableRecords } = await scanMediaLibrary(dataDir, sessions, deleted);
  const projects = [...new Set(items.map(item => item.root))].sort();
  const needle = search.trim().toLocaleLowerCase();
  const filtered = items.filter(item => (kind === 'all' || item.kind === kind) &&
    (!project || item.root === project) && (!needle ||
      [item.displayName, item.prompt, item.sessionName, item.root, item.filename].some(value => value.toLocaleLowerCase().includes(needle))))
    .sort((a, b) => view === 'workspace' && a.root !== b.root ? (a.root < b.root ? -1 : 1) : orderKey(a) < orderKey(b) ? 1 : orderKey(a) > orderKey(b) ? -1 : 0);
  let remaining = filtered;
  if (cursor) {
    if (view === 'workspace') {
      let key;
      try { key = JSON.parse(cursor); } catch { throw new Error('Invalid media library cursor'); }
      if (!Array.isArray(key) || key.length !== 2 || key.some(v => typeof v !== 'string')) throw new Error('Invalid media library cursor');
      remaining = filtered.filter(item => item.root > key[0] || (item.root === key[0] && orderKey(item) < key[1]));
    } else remaining = filtered.filter(item => orderKey(item) < cursor);
  }
  const page = all ? filtered : remaining.slice(0, 48);
  const groups = new Map();
  for (const item of filtered) {
    if (!groups.has(item.root)) groups.set(item.root, []);
    groups.get(item.root).push(item);
  }
  const projectStats = [...groups].map(([root, assets]) => ({ root, count: assets.length, sizeBytes: bytes(assets) }));
  return { items: page, total: filtered.length, projects, projectStats, unreadableRecords,
    totalBytes: bytes(filtered), libraryBytes: bytes(items), libraryCount: items.length,
    nextCursor: !all && remaining.length > page.length ? (view === 'workspace' ? JSON.stringify([page.at(-1).root, orderKey(page.at(-1))]) : orderKey(page.at(-1))) : null };
}

// Only ordinary descendants of the receipt's generated job directory may be
// deleted. In particular, a link to another file inside the workspace is unsafe.
async function deletionTarget(asset) {
  let root;
  try { root = await realpath(asset.root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (path.resolve(root) !== path.resolve(asset.root) || !inside(root, asset.path)) throw new Error('Unsafe workspace path');
  const relative = path.relative(root, asset.path).split(path.sep);
  let current = root;
  for (const [index, part] of relative.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || (index < relative.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Linked or non-file asset cannot be deleted');
    if (path.resolve(await realpath(current)) !== path.resolve(current)) throw new Error('Asset path changed');
  }
  return current;
}

const deletionQueues = new WeakMap();
export async function deleteMediaLibrary(store, input) {
  if (input?.confirm !== true || !Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 500 || input.ids.some(id => typeof id !== 'string' || id.length > 1000))
    throw Object.assign(new Error('Confirm between 1 and 500 media IDs'), { code: -32602 });
  const run = async () => {
    const state = store.read(['sessions', 'mediaLibraryDeleted'], { sessionFields: ['id', 'name', 'title', 'cwd'] });
    const hidden = new Set(state.mediaLibraryDeleted ?? []);
    const { items } = await scanMediaLibrary(store.directory, state.sessions, [...hidden]);
    const byId = new Map(items.map(item => [item.id, item]));
    const results = [];
    for (const id of new Set(input.ids)) {
      try {
        if (!hidden.has(id)) {
          const asset = byId.get(id);
          if (!asset) throw new Error('Media no longer exists or is not a valid generated asset');
          const target = await deletionTarget(asset);
          if (target) await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await store.update(draft => { draft.mediaLibraryDeleted = [...new Set([...(draft.mediaLibraryDeleted ?? []), id])]; }, ['mediaLibraryDeleted']);
          hidden.add(id);
        }
        results.push({ id, deleted: true });
      } catch (error) { results.push({ id, deleted: false, error: error.message }); }
    }
    return { results };
  };
  const promise = (deletionQueues.get(store) ?? Promise.resolve()).then(run);
  deletionQueues.set(store, promise.catch(() => {}));
  return promise;
}
