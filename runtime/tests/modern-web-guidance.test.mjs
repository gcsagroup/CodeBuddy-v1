import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarnessDriver } from '../harness/index.mjs';
import { LibraryService } from '../library.mjs';
import { openStore } from '../store.mjs';
import staging from '../../scripts/stage-harness-distribution.cjs';

test('toolbox lists Modern Web Guidance and Harness can load its offline resources', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-web-guidance-')));
  const store = await openStore(path.join(root, 'data'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  const library = new LibraryService(store, { driver });
  t.after(async () => {
    await library.close();
    await driver.close();
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });
  const { skills } = await library.skillRequest('list', { projectDir: root });
  for (const name of ['web-acceptance', 'code-navigation', 'versioned-docs', 'media-quality']) {
    assert.equal(skills.filter(skill => skill.name === name).length, 1);
  }
  const matches = skills.filter(skill => skill.name === 'modern-web-guidance');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source.rootKind, 'builtin');
  assert.equal(matches[0].readOnly, true);
  const { sessionId } = await driver.createSession({ cwd: root, model: 'fixture',
    provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1', contextWindow: 65536 } });
  const skill = await driver.callTool(sessionId, 'skill', { name: 'modern-web-guidance' });
  assert.equal(skill.isError, false, JSON.stringify(skill));
  assert.match(JSON.stringify(skill.content), /ime-safe-enter-submit/);
  const summary = (await driver.listSkills(sessionId)).find(candidate => candidate.name === matches[0].name);
  const guide = await driver.callTool(sessionId, 'read', {
    file_path: path.join(summary.resourceBase.path, 'guides/forms/ime-safe-enter-submit.md'),
  }, { onPermission: () => true });
  assert.equal(guide.isError, false, JSON.stringify(guide));
  assert.match(JSON.stringify(guide.content), /isComposing/);

  const staged = path.join(root, 'stage');
  await staging.copyHarnessSources(fileURLToPath(new URL('../harness/', import.meta.url)), staged);
  for (const [name, marker] of [
    ['systematic-debugging', 'Root Cause'],
    ['verification-before-completion', 'FRESH VERIFICATION EVIDENCE'],
  ]) {
    const entries = skills.filter(skill => skill.name === name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source.rootKind, 'builtin');
    const loaded = await driver.callTool(sessionId, 'skill', { name });
    assert.equal(loaded.isError, false);
    assert.ok(JSON.stringify(loaded.content).includes(marker));
    const asset = path.join(staged, 'skills', 'superpowers', name, 'SKILL.md');
    assert.ok((await readFile(asset, 'utf8')).includes(marker));
  }
  const directory = path.join(staged, 'skills', matches[0].name);
  const entry = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  assert.match(await readFile(path.join(directory, 'LICENSE'), 'utf8'), /Apache License/);
  for (const index of await readdir(path.join(directory, 'index'))) {
    assert.ok(entry.includes('index/' + index));
    const contents = await readFile(path.join(directory, 'index', index), 'utf8');
    for (const [, link] of contents.matchAll(/\]\(([^)]+\.md)\)/g))
      assert.ok((await readFile(path.join(directory, 'index', link))).length > 0);
  }
});
