import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// A small durable tombstone is the deletion commit. Large state snapshots and
// resource disposal may lag behind it, including across a process restart.
export async function openSessionDeletionJournal(directory, { replaceFile = rename } = {}) {
  const folder = path.join(directory, 'session-deletions');
  const records = new Map();
  const filename = id => createHash('sha256').update(id).digest('hex') + '.json';
  const names = await readdir(folder).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(await readFile(path.join(folder, name), 'utf8'));
    if (record.version !== 1 || typeof record.id !== 'string' || !record.id ||
        typeof record.nativeSessionId !== 'string' || !record.nativeSessionId ||
        typeof record.acceptedAt !== 'string' || name !== filename(record.id))
      throw new Error('Invalid session deletion record: ' + name);
    records.set(record.id, record);
  }
  let tail = Promise.resolve();
  const serial = operation => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  return {
    get size() { return records.size; },
    has: id => records.has(id),
    list: () => structuredClone([...records.values()]),
    accept: record => serial(async () => {
      if (records.has(record.id)) return structuredClone(records.get(record.id));
      const file = path.join(folder, filename(record.id));
      const tmp = file + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(tmp, JSON.stringify(record), { mode: 0o600, flush: true });
        await replaceFile(tmp, file);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
      records.set(record.id, structuredClone(record));
      return structuredClone(record);
    }),
    finish: id => serial(async () => {
      if (!records.has(id)) return;
      // The caller has already durably pruned the full snapshot and completed
      // cleanup. Failed removal keeps the tombstone available for a retry.
      await unlink(path.join(folder, filename(id)));
      records.delete(id);
    }),
    flush: () => tail,
  };
}
