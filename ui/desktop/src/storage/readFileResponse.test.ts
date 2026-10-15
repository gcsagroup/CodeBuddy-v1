import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileResponse } from './readFileResponse';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-rules-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it('treats an absent override as optional and reads or creates the regular rules file', async () => {
  expect(await readFileResponse(path.join(root, 'AGENTS.override.md'))).toMatchObject({
    found: false,
    error: null,
  });
  const file = path.join(root, 'AGENTS.md');
  expect(await readFileResponse(file)).toMatchObject({ found: false, error: null });
  await fs.writeFile(file, '繁體規則\r\n');
  expect(await readFileResponse(file)).toMatchObject({
    found: true,
    error: null,
    file: '繁體規則\r\n',
  });
});
it('does not hide a filesystem error as a missing file', async () => {
  const result = await readFileResponse(root);
  expect(result.found).toBe(false);
  expect(result.error).toBeTruthy();
});
