import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, realpath, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentTools } from '../development-tools.mjs';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const prepared = existsSync(path.join(assets, 'serena/serena/cli.py')) &&
  existsSync(path.join(assets, 'pyright/dist/pyright-langserver.js'));

test('bundled Python code queries work without uv or system Node and retain workspace boundaries',
  { skip: !prepared && 'Prepare Serena and Pyright native payloads first', timeout: 120000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy navigation ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const source = 'def add(left, right):\n    return left + right\n\nresult = add(7, 11)\n';
    await writeFile(path.join(workspace, 'sample.py'), source);
    await writeFile(path.join(root, 'outside.py'), 'private = 1\n');
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
    const tool = developmentTools({ cwd: workspace, dataDir: path.join(root, 'state') })
      .find(tool => tool.name === 'code_navigation');
    await assert.rejects(tool.execute({ operation: 'overview', path: '../outside.py' }), /inside the current workspace/);
    for (const operation of ['overview', 'definition', 'references']) {
      const result = await tool.execute({ operation, path: 'sample.py', symbol: 'add' }, { signal: t.signal });
      assert.notEqual(result.isError, true);
      assert.match(JSON.stringify(result), operation === 'references' ? /result = add/ : /add/);
    }
    assert.equal(await readFile(path.join(workspace, 'sample.py'), 'utf8'), source);
    assert.equal(await readFile(path.join(root, 'outside.py'), 'utf8'), 'private = 1\n');
  });
