import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { desktopPetTool } from '../desktop-pet-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-pet-tool-'));
  const cwd = path.join(root, 'workspace'), directory = path.join(root, 'pets');
  await mkdir(cwd);
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('codebuddy-pet-tool-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, directory, tool: desktopPetTool({ cwd, directory }) };
}
test('preparation keeps the main Agent, requires real image capability and never selects a pet', async t => {
  const { tool } = await fixture(t);
  const result = await tool.execute({ operation: 'prepare' });
  assert.equal(result.status, 'needs_images');
  assert.equal(result.automaticallySelected, false);
  assert.match(result.instructions, /text-only model/);
  assert.equal(result.states.length, 8);
});
test('assembles real generated PNG pixels in an isolated library and preserves existing packages', async t => {
  const { cwd, directory, tool } = await fixture(t);
  await copyFile(fileURLToPath(new URL('../../ui/desktop/src/pets/assets/red-panda/sprites.png', import.meta.url)), path.join(cwd, 'source.png'));
  const input = { operation: 'assemble', id: 'test-panda', name: 'Test panda', description: 'Generated fixture art', sources: { sheet: 'source.png' } };
  const result = await tool.execute(input);
  assert.equal(result.status, 'ready_for_preview');
  assert.equal(result.automaticallySelected, false);
  assert.equal(result.visualReviewRequired, true);
  const png = await readFile(path.join(directory, 'test-panda/sprites.png'));
  assert.equal(png.readUInt32BE(16), 1152);
  assert.equal(png.readUInt32BE(20), 1664);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'test-panda/pet.json'), 'utf8')).name, 'Test panda');
  await assert.rejects(tool.execute(input), /already exists/);
  assert.deepEqual(await readFile(path.join(directory, 'test-panda/sprites.png')), png);
  assert.deepEqual(await readdir(directory), ['test-panda']);
});
test('rejects reserved IDs, outside images, invalid images and cancellation without publishing', async t => {
  const { root, cwd, directory, tool } = await fixture(t);
  const input = { operation: 'assemble', id: 'invalid-art', name: 'Test', description: '', sources: { sheet: 'bad.png' } };
  await writeFile(path.join(cwd, 'bad.png'), 'not an image');
  await assert.rejects(tool.execute({ ...input, id: '../escape' }), /pet ID/);
  await assert.rejects(tool.execute({ ...input, id: 'red-panda' }), /pet ID/);
  await writeFile(path.join(root, 'outside.png'), 'outside');
  await assert.rejects(tool.execute({ ...input, sources: { sheet: '../outside.png' } }), /inside this session/);
  await assert.rejects(tool.execute(input), /assembly failed/);
  assert.deepEqual(await readdir(directory), []);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tool.execute(input, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(directory), []);
});

test('the official Harness discovers and executes the built-in pet tool with normal permissions', async t => {
  const { root, cwd, tool } = await fixture(t);
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd });
  try {
    const { sessionId } = await driver.createSession({ cwd, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: { tools: [tool], toolFilter: { allow: [] } } });
    assert.ok((await driver.listTools(sessionId)).some(item => item.name === tool.name));
    const found = await driver.callTool(sessionId, 'search_mcp_tools', { names: [tool.name] }, { onPermission: () => true });
    assert.equal(found.isError, false);
    const result = await driver.callTool(sessionId, tool.name, { operation: 'prepare' }, { onPermission: () => true });
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result), /needs_images/);
  } finally { await driver.close(); }
});
