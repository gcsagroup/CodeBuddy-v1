import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('desktop has a single Harness entry and independent tool workspace', async () => {
  const cargo = await fs.readFile(path.join(root, 'Cargo.toml'), 'utf8');
  assert.match(cargo, /members = \["crates\/goose-mcp"\]/);
  const main = await fs.readFile(path.join(root, 'ui/desktop/src/main.ts'), 'utf8');
  assert.match(main, /startHarnessService/);
  assert.doesNotMatch(main, /findGooseBinaryPath|startGooseServe|runStorageMigration|harnessMode/);
  for (const crate of ['goose', 'goose-cli', 'goose-providers', 'goose-local-inference', 'goose-sdk']) {
    await assert.rejects(fs.access(path.join(root, 'crates', crate, 'Cargo.toml')), { code: 'ENOENT' });
  }
  for (const name of ['acp-schema.json', 'acp-meta.json']) {
    JSON.parse(await fs.readFile(path.join(root, 'ui/sdk/schema', name), 'utf8'));
  }
});
