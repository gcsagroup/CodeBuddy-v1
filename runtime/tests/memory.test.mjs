import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectMemory } from '../memory.mjs';
import { zCodeProMemoryListResponse_unstable, zCodeProMemoryStatusResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-memory-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^codebuddy-memory-/);
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = new Map();
  const memory = new ProjectMemory({ memory: {
    get: (scope, key) => structuredClone(rows.get(JSON.stringify([scope, key]))?.value),
    list: scope => [...rows.values()].filter(x => x.scope === scope).map(x => structuredClone(x)),
    set: async (scope, key, value) => rows.set(JSON.stringify([scope, key]), { scope, key, value: structuredClone(value) }),
    delete: async (scope, key) => rows.delete(JSON.stringify([scope, key])),
  } });
  const request = (action, params = {}) => memory.request('codepro/memory/' + action, { schemaVersion: 1, workingDir: root, ...params });
  return { root, memory, request, rows };
}
test('only reviewed active project memories are recalled, with original SDK schema and idempotent review', async t => {
  const { root, memory, request } = await fixture(t);
  const { record } = await memory.retain(root, { subject: 'Build command', content: 'Use node --test packages/*/test/*.mjs' });
  assert.equal(record.status, 'candidate'); assert.deepEqual(await memory.recall(root), []);
  const result = await request('list'); zCodeProMemoryListResponse_unstable.parse(result);
  const activation = { id: record.id, expectedStatus: record.status, expectedUpdatedAt: record.updatedAt, reviewFingerprint: record.reviewFingerprint, actionId: 'approve-one', targetStatus: 'active' };
  const activated = await request('status', activation); zCodeProMemoryStatusResponse_unstable.parse(activated);
  assert.deepEqual(await request('status', activation), activated);
  assert.equal((await memory.recall(root, 'Build')).length, 1);
  const other = path.join(root, 'other-project'); await mkdir(other);
  assert.deepEqual(await memory.recall(other), []);
  await request('status', { ...activation, actionId: 'disable-one', expectedStatus: 'active', expectedUpdatedAt: activated.record.updatedAt, reviewFingerprint: activated.record.reviewFingerprint, targetStatus: 'disabled' });
  assert.deepEqual(await memory.recall(root), []);
});
test('stale memory review cannot activate edited contents; export and delete retain consistent records', async t => {
  const { root, memory, request } = await fixture(t);
  const { record } = await memory.retain(root, { subject: 'Convention', content: 'Old convention' });
  await request('update', { id: record.id, content: 'Changed convention', reason: 'User revision', ttlDays: 2 });
  await assert.rejects(() => request('status', { id: record.id, expectedStatus: 'candidate', expectedUpdatedAt: record.updatedAt, reviewFingerprint: record.reviewFingerprint, actionId: 'stale', targetStatus: 'active' }), /changed/);
  assert.match((await request('export')).json, /Changed convention/);
  assert.equal((await request('delete', { id: record.id })).removed, true);
  assert.equal((await request('delete', { id: record.id })).removed, false);
  assert.equal((await request('list')).totalRecords, 0);
});

async function activate(request, record, actionId) {
  return (await request('status', { id: record.id, expectedStatus: record.status, expectedUpdatedAt: record.updatedAt, reviewFingerprint: record.reviewFingerprint, actionId, targetStatus: 'active' })).record;
}

test('session memory injects only active current-project records and the preference changes proposal policy', async t => {
  const { root, memory, request } = await fixture(t);
  const active = await activate(request, (await memory.retain(root, { subject: 'approved-subject', content: 'APPROVED_PROJECT_MARKER' })).record, 'activate-current');
  await memory.retain(root, { subject: 'candidate', content: 'CANDIDATE_MARKER' });
  const disabled = await activate(request, (await memory.retain(root, { subject: 'disabled', content: 'DISABLED_MARKER' })).record, 'activate-disabled');
  await request('status', { id: disabled.id, expectedStatus: 'active', expectedUpdatedAt: disabled.updatedAt, reviewFingerprint: disabled.reviewFingerprint, actionId: 'disable-record', targetStatus: 'disabled' });
  const expired = await activate(request, (await memory.retain(root, { subject: 'expired', content: 'EXPIRED_MARKER' })).record, 'activate-expired');
  const scope = await memory.scope(root);
  await memory.driver.memory.set(scope, `record:${expired.id}`, { ...expired, expiresAt: '2020-01-01T00:00:00.000Z' });
  const other = path.join(root, 'other'); await mkdir(other);
  const otherRecord = (await memory.retain(other, { subject: 'foreign', content: 'OTHER_PROJECT_MARKER' })).record;
  const otherRequest = (action, params) => memory.request('codepro/memory/' + action, { schemaVersion: 1, workingDir: other, ...params });
  await activate(otherRequest, otherRecord, 'activate-other');
  const off = await memory.sessionInstructions({ cwd: root });
  assert.match(off, /Automatic project habit learning is disabled/);
  assert.match(off, /explicit user request/);
  assert.match(off, /APPROVED_PROJECT_MARKER/);
  for (const marker of ['CANDIDATE_MARKER', 'DISABLED_MARKER', 'EXPIRED_MARKER', 'OTHER_PROJECT_MARKER']) assert.equal(off.includes(marker), false);
  const on = await memory.sessionInstructions({ cwd: root }, { personalizedMemoryEnabled: true });
  assert.match(on, /Automatic project habit learning is enabled/);
  assert.match(on, /activation requires user review in the UI/);
  assert.deepEqual(JSON.parse(off.split('\n').at(-1)).records.map(record => record.id), [active.id]);
  assert.equal(JSON.parse(on.split('\n').at(-1)).records.length, 1);
  const retained = await memory.tools({ id: 'explicit-user-request', cwd: root })[0].execute({ action: 'retain', subject: 'remember-request', content: 'EXPLICIT_CANDIDATE_MARKER' });
  assert.equal(retained.record.status, 'candidate');
  assert.equal((await memory.sessionInstructions({ cwd: root })).includes('EXPLICIT_CANDIDATE_MARKER'), false);
  await request('delete', { id: active.id });
  assert.equal((await memory.sessionInstructions({ cwd: root })).includes('APPROVED_PROJECT_MARKER'), false, 'instructions read the current store, not a stale active-memory cache');
});

test('session memory keeps a bounded context without silently truncating approved records', async t => {
  const { root, memory, request } = await fixture(t);
  for (let index = 0; index < 3; index++) await activate(request, (await memory.retain(root, { subject: `large-${index}`, content: `LONG_RECORD_MARKER_${index}` + '记'.repeat(1900) })).record, `large-${index}`);
  await activate(request, (await memory.retain(root, { subject: 'small', content: 'SMALL_RECORD_MARKER' })).record, 'small');
  const instructions = await memory.sessionInstructions({ cwd: root }, { personalizedMemoryEnabled: true });
  const payload = JSON.parse(instructions.split('\n').at(-1));
  assert.equal(payload.omittedRecords, 1);
  assert.equal(payload.records.length, 3);
  assert.ok(payload.records.some(record => record.content === 'SMALL_RECORD_MARKER'));
  for (const record of payload.records.filter(record => record.subject.startsWith('large'))) assert.equal(record.content.split('记').length - 1, 1900);
  assert.ok(Buffer.byteLength(instructions) < 18 * 1024);
  assert.equal((await memory.recall(root, 'LONG_RECORD_MARKER'))[0].content.startsWith('LONG_RECORD_MARKER'), true, 'oversized instructions remain available through the existing explicit recall tool');
});

test('more than fifty records paginate with the original UUID cursor schema without duplicates', async t => {
  const { root, memory, request } = await fixture(t);
  for (let index = 0; index < 53; index++) await memory.retain(root, { subject: `record-${index}`, content: 'saved project context' });
  const first = zCodeProMemoryListResponse_unstable.parse(await request('list'));
  assert.equal(first.records.length, 50);
  assert.equal(first.totalRecords, 53);
  assert.equal(first.nextCursor, first.records.at(-1).id);
  const second = zCodeProMemoryListResponse_unstable.parse(await request('list', { cursor: first.nextCursor }));
  assert.equal(second.records.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records].map(record => record.id)).size, 53);
  await assert.rejects(request('list', { cursor: '50' }), /pagination/);
  await assert.rejects(request('list', { pageSize: 51 }), /pagination/);
  await request('delete', { id: first.nextCursor });
  await assert.rejects(request('list', { cursor: first.nextCursor }), /refresh/);
});

test('tool proposals and UI edits reject values exceeding the original memory record contract', async t => {
  const { root, memory, request } = await fixture(t);
  const base = { subject: 'subject', content: 'content', reason: 'reason' };
  for (const input of [{ content: 'x'.repeat(2001) }, { subject: 'x'.repeat(121) }, { kind: 'x'.repeat(33) }, { reason: 'x'.repeat(501) }, { sourceRef: 'x'.repeat(1025) }]) await assert.rejects(memory.retain(root, { ...base, ...input }), /exceeds/);
  assert.equal((await request('list')).totalRecords, 0);
  const record = (await memory.retain(root, base)).record;
  for (const input of [{ content: 'x'.repeat(2001) }, { reason: 'x'.repeat(501) }, { ttlDays: 0.5 }, { ttlDays: 3651 }]) await assert.rejects(request('update', { id: record.id, content: 'updated', reason: 'edit', ...input }), /exceeds|retention/);
  assert.equal((await request('get', { id: record.id })).record.content, 'content');
  zCodeProMemoryListResponse_unstable.parse(await request('list'));
});
