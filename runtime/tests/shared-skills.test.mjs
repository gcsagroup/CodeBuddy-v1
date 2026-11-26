import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillCatalog } from '../harness/skill-catalog.mjs';
import { LibraryService } from '../library.mjs';
import { openStore } from '../store.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import * as schemas from '../../ui/sdk/dist/generated/zod.gen.js';

const raw = (name, body = 'Read a public page.') => `---\nname: ${name}\ndescription: Shared test skill\n---\n${body}`;
async function put(root, name, text = raw(name)) {
  const file = path.join(root, name, 'SKILL.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-shared-')));
  const config = { dshHome: path.join(root, 'data', 'harness'), agentsHome: path.join(root, 'data', 'harness', 'agents'), sharedSkillDir: path.join(root, 'shared') };
  const store = await openStore(path.join(root, 'data'));
  let invalidations = 0;
  const catalog = new SkillCatalog({ get: () => undefined, logger: { warn() {} } }, { invalidate() { invalidations++; }, signal: new AbortController().signal }, config);
  const driver = { skillCatalog: cwd => catalog.inventory(cwd), setSharedSkillEnabled: (...args) => catalog.setEnabled(...args) };
  const library = new LibraryService(store, { driver });
  t.after(async () => { await library.close(); await catalog.dispose(); await store.flush(); assert.equal(path.dirname(root), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith('codebuddy-shared-')); await rm(root, { recursive: true, force: true }); });
  return { root, config, catalog, library, invalidations: () => invalidations };
}

test('shared install is visible but not invocable before explicit enable; persisted choice never edits source', async t => {
  const { root, config, catalog, library } = await fixture(t);
  const file = await put(config.sharedSkillDir, 'agent-reach');
  const original = await readFile(file, 'utf8');
  const listed = schemas.zSkillManagementListResponse_unstable.parse(await library.listSkills(root));
  const skill = listed.skills.find(s => s.name === 'agent-reach');
  assert.equal(skill.availability, 'pending');
  assert.equal(skill.readOnly, true);
  assert.equal(skill.canToggle, true);
  assert.deepEqual(await catalog.list({ cwd: root }), []);
  let approvals = 0;
  const connection = { ask: async (_, request) => { approvals++; return { decision: 'confirm', nonce: request.nonce }; } };
  const preview = await library.preview({ projectDir: root, change: { operation: 'set_enabled', source: skill.source, expectedVersion: skill.version, enabled: true } }, connection);
  assert.equal(preview.requiresConfirmation, true);
  await library.apply(preview.previewToken, connection);
  assert.equal(approvals, 1);
  const candidates = await catalog.list({ cwd: root });
  assert.equal(candidates[0].name, 'agent-reach');
  assert.match((await catalog.get(candidates[0], { cwd: root })).content, /Read a public page/);
  assert.equal(await readFile(file, 'utf8'), original);
  const restarted = new SkillCatalog({ get: () => undefined, logger: { warn() {} } }, { invalidate() {}, signal: new AbortController().signal }, config);
  assert.equal((await restarted.list({ cwd: root }))[0].name, 'agent-reach');
  await restarted.dispose();
  const enabled = (await library.listSkills(root)).skills[0];
  const off = await library.preview({ projectDir: root, change: { operation: 'set_enabled', source: enabled.source, expectedVersion: enabled.version, enabled: false } }, connection);
  await library.apply(off.previewToken, connection);
  assert.deepEqual(await catalog.list({ cwd: root }), []);
  assert.equal(await catalog.get(candidates[0], { cwd: root }), undefined, 'stale handles cannot load disabled skills');
  assert.equal(approvals, 1, 'disable needs no extra trust prompt');
});

test('cancelled trust and changed sources never enable; shared editing/deletion are rejected', async t => {
  const { root, config, library, catalog } = await fixture(t);
  const file = await put(config.sharedSkillDir, 'shared-demo');
  const skill = (await library.listSkills(root)).skills[0];
  const change = { operation: 'set_enabled', source: skill.source, expectedVersion: skill.version, enabled: true };
  const cancel = { ask: async () => ({ decision: 'cancel' }) };
  const pending = await library.preview({ projectDir: root, change }, cancel);
  await assert.rejects(library.apply(pending.previewToken, cancel), /confirmation_cancelled/);
  assert.deepEqual(await catalog.list({ cwd: root }), []);
  for (const operation of ['delete', 'update_raw']) await assert.rejects(library.preview({ projectDir: root, change: { ...change, operation, rawDocument: raw('shared-demo') } }, cancel), /read_only/);
  const approve = { ask: async (_, r) => { await writeFile(file, raw('shared-demo', 'Changed instructions')); return { decision: 'confirm', nonce: r.nonce }; } };
  const stale = await library.preview({ projectDir: root, change }, approve);
  await assert.rejects(library.apply(stale.previewToken, approve), /stale_source/);
  assert.deepEqual(await catalog.list({ cwd: root }), []);
});

test('catalog deduplicates links, exposes shadowed source and malformed files, refreshes additions and removals', async t => {
  const { root, config, catalog, library, invalidations } = await fixture(t);
  const first = await put(config.sharedSkillDir, 'common');
  await symlink(path.dirname(first), path.join(config.sharedSkillDir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await put(path.join(root, '.agents', 'skills'), 'common', raw('common', 'Project wins'));
  await put(config.sharedSkillDir, 'bad', '---\nname: [broken\n---\nbad');
  const listed = await library.listSkills(root);
  assert.equal(listed.skills.filter(s => s.name === 'common').length, 2);
  assert.ok(listed.diagnostics.some(s => /invalid YAML/.test(s)));
  assert.equal(listed.skills.find(s => s.scope === 'shared').availability, 'shadowed');
  const shared = listed.skills.find(s => s.scope === 'shared');
  const confirm = { ask: async (_, r) => ({ decision: 'confirm', nonce: r.nonce }) };
  const grant = await library.preview({ projectDir: root, change: { operation: 'set_enabled', source: shared.source, expectedVersion: shared.version, enabled: true } }, confirm);
  await library.apply(grant.previewToken, confirm);
  const shadowed = (await library.listSkills(root)).skills.find(s => s.scope === 'shared');
  assert.equal(shadowed.enabled, true, 'keep the toggle state distinct from which source wins');
  assert.equal(shadowed.availability, 'shadowed');
  const revoke = await library.preview({ projectDir: root, change: { operation: 'set_enabled', source: shadowed.source, expectedVersion: shadowed.version, enabled: false } }, confirm);
  await library.apply(revoke.previewToken, confirm);
  assert.equal((await library.listSkills(root)).skills.find(s => s.scope === 'shared').enabled, false);
  const candidate = (await catalog.list({ cwd: root }))[0];
  assert.match((await catalog.get(candidate, { cwd: root })).content, /Project wins/);
  const before = invalidations();
  await catalog.inventory(root); await catalog.inventory(root);
  assert.equal(invalidations(), before, 'unchanged files reuse parsed catalog');
  await put(config.sharedSkillDir, 'new-skill');
  assert.ok((await library.listSkills(root)).skills.some(s => s.name === 'new-skill'));
  const removed = path.join(config.sharedSkillDir, 'new-skill');
  assert.equal(path.dirname(removed), config.sharedSkillDir);
  await rm(removed, { recursive: true });
  assert.ok(!(await library.listSkills(root)).skills.some(s => s.name === 'new-skill'));
});

test('live Harness uses same catalog and existing session sees newly enabled and disabled skills', async t => {
  const { root, config } = await fixture(t);
  await put(config.sharedSkillDir, 'live-shared', raw('live-shared', 'Shared live receipt 42'));
  const driver = await createHarnessDriver({ dataDir: config.dshHome, cwd: root, sharedSkillDir: config.sharedSkillDir });
  t.after(() => driver.close());
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'offline', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' }, model: 'fixture' });
  assert.ok(!(await driver.listSkills(sessionId)).some(s => s.name === 'live-shared'));
  const snapshot = await driver.skillCatalog(root);
  const candidate = snapshot.candidates.find(s => s.name === 'live-shared');
  const catalogVersion = (await fixtureVersion(candidate));
  await driver.setSharedSkillEnabled(root, candidate.path, catalogVersion, true);
  assert.ok((await driver.listSkills(sessionId)).some(s => s.name === 'live-shared'));
  const loaded = await driver.callTool(sessionId, 'skill', { name: 'live-shared' }, { onPermission: () => true });
  assert.equal(loaded.isError, false, JSON.stringify(loaded));
  assert.match(JSON.stringify(loaded), /Shared live receipt 42/);
  const before = (await driver.listSkills(sessionId)).find(s => s.name === 'live-shared');
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  await put(config.sharedSkillDir, 'live-shared', raw('live-shared', 'Shared live receipt 43'));
  await driver.refreshSkills();
  const changed = (await driver.listSkills(sessionId)).find(s => s.name === 'live-shared');
  assert.equal(changed.description, before.description);
  assert.notEqual(changed.revision, before.revision, 'body-only edits invalidate the native catalog');
  assert.equal((await driver.listSkills(sessionId)).find(s => s.name === 'live-shared').revision, changed.revision, 'unchanged catalogs retain a stable revision');
  assert.match(JSON.stringify(await driver.callTool(sessionId, 'skill', { name: 'live-shared' }, { onPermission: () => true })), /Shared live receipt 43/);
  const enabled = (await driver.skillCatalog(root)).candidates.find(s => s.name === 'live-shared');
  await driver.setSharedSkillEnabled(root, enabled.path, await fixtureVersion(enabled), false);
  assert.ok(!(await driver.listSkills(sessionId)).some(s => s.name === 'live-shared'));
});

async function fixtureVersion(candidate) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify([candidate.identity, candidate.rawDocument, candidate.sharedEnabled])).digest('hex');
}
