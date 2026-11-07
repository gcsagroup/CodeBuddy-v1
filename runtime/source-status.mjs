import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Development diagnostics only: never reload a live session or decide its outcome.
export async function createSourceStatus(root, { intervalMs = 30000 } = {}) {
  async function fingerprint(directory = root) {
    const hash = createHash('sha256');
    const ignored = new Set(['node_modules', 'test', 'tests', 'assets', 'tools', 'skills', 'office-assets']);
    async function visit(dir) {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (/\.(mjs|cjs|json)$/.test(entry.name)) {
          hash.update(path.relative(directory, file));
          hash.update(await readFile(file));
        }
      }
    }
    await visit(directory);
    return hash.digest('hex');
  }
  const sourceHash = await fingerprint();
  const identity = { pid: process.pid, startedAt: new Date().toISOString(), sourceHash };
  let checkedAt = Date.now(), currentHash = sourceHash, pending;
  return async () => {
    if (Date.now() - checkedAt >= intervalMs) {
      pending ??= fingerprint().then(hash => { currentHash = hash; checkedAt = Date.now(); })
        .finally(() => { pending = undefined; });
      await pending;
    }
    return { ...identity, currentHash, restartRequired: currentHash !== sourceHash };
  };
}
