import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../ui/node_modules/esbuild/lib/main.js';
import { openStore } from '../store.mjs';
import { CodeProReviews } from '../codepro-review.mjs';
import { captureReviewSnapshot } from '../review-snapshot.mjs';
import { gitTools } from '../git-extension.mjs';
import { zCodeProReviewSnapshotResponse_unstable, zCodeProReviewResultResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const model = { provider: 'fixture-provider', model: 'fixture-model' };
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-review-')), cwd = path.join(root, 'repo'); await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, '模块.mjs'), 'export const sum = (a,b) => a+b;\n'); git('add', '--', '模块.mjs');
  await writeFile(path.join(cwd, '模块.mjs'), 'export const sum = (a,b) => a-b;\n');
  const store = await openStore(path.join(root, 'data')), scripts = [], calls = [];
  const context = { cwd, model: structuredClone(model) };
  const reviews = new CodeProReviews(store, { resolveContext: async sessionId => { assert.equal(sessionId, 'session'); return context; }, runReview: async input => { calls.push(input); await scripts.shift()(input); }, ...options });
  await reviews.initialize(); t.after(() => reviews.close());
  const request = async (method, params = {}) => {
    const result = await reviews.request(`codepro/review/${method}`, { schemaVersion: 1, sessionId: 'session', ...params });
    (method === 'snapshot' ? zCodeProReviewSnapshotResponse_unstable : zCodeProReviewResultResponse_unstable).parse(result);
    return result;
  };
  return { root, cwd, git, store, scripts, calls, context, reviews, request };
}
const finding = snapshot => ({ id: 'math-subtraction', priority: 1, title: 'Sum subtracts the second operand', body: 'Calling sum(1, 2) produces -1 instead of 3.', path: snapshot.files[0].path, side: 'new', startLine: 1, endLine: 1 });
const finish = async (f, reviewId) => { await f.reviews.active.get(reviewId)?.done; return f.request('get', { reviewId, includeSnapshot: true }); };

test('actual Git snapshots preserve staged/worktree distinction, hashes, hunks and excluded content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'new.mjs'), 'export const fresh = true;\n');
  await writeFile(path.join(f.cwd, '.env'), 'SECRET=never-send-this\n');
  await writeFile(path.join(f.cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(f.cwd, 'large.txt'), 'x'.repeat(65537));
  const before = await readFile(path.join(f.cwd, '.git/index'));
  const { snapshot } = await f.request('snapshot', { scope: 'working_tree' });
  assert.equal(snapshot.headOid, null);
  assert.equal(snapshot.coverage, 'partial');
  assert.deepEqual(snapshot.excludedFiles, [{ path: '.env', reason: 'sensitive_path' }, { path: 'binary.bin', reason: 'binary_or_non_utf8' }, { path: 'large.txt', reason: 'file_too_large' }]);
  assert.ok(!JSON.stringify(snapshot).includes('never-send-this'));
  const edited = snapshot.files.find(file => file.path === '模块.mjs');
  assert.match(edited.oldText, /a\+b/); assert.match(edited.newText, /a-b/);
  assert.notEqual(edited.oldHash, edited.newHash);
  assert.deepEqual(edited.hunks, [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
  assert.equal(snapshot.files.find(file => file.path === 'new.mjs').oldText, '');
  const staged = (await f.request('snapshot', { scope: 'staged' })).snapshot;
  assert.equal(staged.coverage, 'complete'); assert.equal(staged.files.length, 1);
  assert.equal(staged.files[0].oldText, ''); assert.match(staged.files[0].newText, /a\+b/);
  assert.equal((await f.request('snapshot', { scope: 'working_tree' })).snapshot.fingerprint, snapshot.fingerprint);
  assert.deepEqual(await readFile(path.join(f.cwd, '.git/index')), before);
  assert.equal(f.git('for-each-ref').trim(), '');
  await assert.rejects(f.request('snapshot', { scope: 'branch', baseRef: 'HEAD' }), /review_head_required/);
});

test('frozen review adapter consumes snapshot/start/get with exact submission, idempotence and stale detection', async t => {
  const f = await fixture(t), key = `reviewFixture${Date.now()}`;
  globalThis[key] = { goose: {}, extMethod: (method, params) => f.reviews.request(method.replace('_goose/unstable/', ''), params) };
  t.after(() => { delete globalThis[key]; });
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../ui/desktop/src/acp/review.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'fixture-acp', setup(builder) {
      builder.onResolve({ filter: /^\.\/acpConnection$/ }, () => ({ path: 'acp', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getAcpControlClient=async()=>globalThis[${JSON.stringify(key)}]`, loader: 'js' }));
    } }] });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const snapshot = await ui.captureCodeProReviewSnapshot('session', 'working_tree');
  f.scripts.push(async ({ tool, snapshot }) => { await tool.execute({ findings: [finding(snapshot)] }); });
  const started = await ui.startCodeProReview('session', snapshot.snapshotId, 'unique-request');
  assert.equal(started.status, 'running');
  await finish(f, started.reviewId);
  const result = await ui.getCodeProReview('session', started.reviewId, true);
  zCodeProReviewResultResponse_unstable.parse(result);
  assert.equal(result.result.status, 'completed'); assert.equal(result.result.findings.length, 1);
  assert.equal(result.result.freshness, 'current'); assert.equal(result.snapshot.fingerprint, snapshot.fingerprint);
  assert.equal((await ui.startCodeProReview('session', snapshot.snapshotId, 'unique-request')).reviewId, started.reviewId);
  assert.equal(f.calls.length, 1);
  await writeFile(path.join(f.cwd, '模块.mjs'), 'export const sum = (a,b) => a*b;\n');
  assert.equal((await ui.getCodeProReview('session', started.reviewId)).result.freshness, 'stale');
  await assert.rejects(ui.startCodeProReview('session', snapshot.snapshotId, 'new-request'), /review_snapshot_stale/);
  assert.equal((await ui.cancelCodeProReview('session', started.reviewId)).status, 'completed');
});

test('end_turn, out-of-hunk locations and partial empty results do not become successful reviews', async t => {
  const f = await fixture(t);
  const { snapshot } = await f.request('snapshot', { scope: 'working_tree' });
  f.scripts.push(async () => {});
  let result = (await f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'text-only' })).result;
  assert.equal((await finish(f, result.reviewId)).result.status, 'failed');
  f.scripts.push(async ({ tool, snapshot }) => { await tool.execute({ findings: [{ ...finding(snapshot), startLine: 99, endLine: 99 }] }); });
  result = (await f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'bad-location' })).result;
  assert.match((await finish(f, result.reviewId)).result.error.message, /review_line_not_in_hunk/);
  await writeFile(path.join(f.cwd, '.env'), 'OMITTED=1');
  const partial = (await f.request('snapshot', { scope: 'working_tree' })).snapshot;
  f.scripts.push(async ({ tool }) => { await tool.execute({ findings: [] }); });
  result = (await f.request('start', { snapshotId: partial.snapshotId, requestId: 'partial-empty' })).result;
  assert.match((await finish(f, result.reviewId)).result.error.message, /incomplete_review_output/);
});

test('cancel waits for the actual reviewer exit and persisted running reviews become interrupted on restart', async t => {
  const f = await fixture(t); let release, observedAbort;
  const abortObserved = new Promise(resolve => { observedAbort = resolve; });
  f.scripts.push(async ({ signal }) => { await new Promise(resolve => { signal.addEventListener('abort', () => { observedAbort(); release = resolve; }, { once: true }); }); });
  const { snapshot } = await f.request('snapshot', { scope: 'working_tree' });
  const { result } = await f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'cancellable' });
  let settled = false;
  const cancelling = f.request('cancel', { reviewId: result.reviewId }).then(value => { settled = true; return value; });
  await abortObserved;
  assert.equal(settled, false); assert.equal(f.store.read().reviews.records[result.reviewId].result.status, 'running');
  release();
  assert.equal((await cancelling).result.status, 'cancelled');
  await f.store.update(state => { state.reviews.records[result.reviewId].result.status = 'running'; });
  const reloaded = await openStore(f.store.directory), restarted = new CodeProReviews(reloaded, { resolveContext: async () => f.context, runReview: async () => { assert.fail('Interrupted review must not replay'); } });
  await restarted.initialize();
  assert.equal((await restarted.request('codepro/review/get', { schemaVersion: 1, sessionId: 'session', reviewId: result.reviewId })).result.status, 'interrupted');
  await restarted.close();
});

test('model changes, cross-session snapshot access and invalid schema are rejected before model execution', async t => {
  const f = await fixture(t);
  const { snapshot } = await f.request('snapshot', { scope: 'working_tree' });
  f.context.model = { provider: 'other', model: 'other-model' };
  await assert.rejects(f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'model-change' }), /review_model_changed/);
  await assert.rejects(f.reviews.request('codepro/review/start', { schemaVersion: 1, sessionId: 'other-session', snapshotId: snapshot.snapshotId, requestId: 'cross-session' }), /review_snapshot_not_found/);
  await assert.rejects(f.reviews.request('codepro/review/get', { schemaVersion: 2, sessionId: 'session', reviewId: 'none' }), /unsupported_review_schema/);
  assert.equal(f.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(captureReviewSnapshot({ sessionId: 'session', ...f.context, scope: 'working_tree' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('branch scope uses immutable merge-base and HEAD blobs, including rename direction, independently of working edits', async t => {
  const f = await fixture(t);
  // These two commits exist only in this generated fixture, on git-init's
  // default branch. No user repository, branch creation or switch is involved.
  const original = 'export const sum = (a,b) => a+b;\n// one\n// two\n// three\n// four\n';
  await writeFile(path.join(f.cwd, '模块.mjs'), original); f.git('add', '--', '模块.mjs');
  const commit = () => f.git('-c', 'user.name=Review Fixture', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', 'isolated review fixture');
  commit(); const base = f.git('rev-parse', 'HEAD').trim();
  f.git('mv', '--', '模块.mjs', 'renamed 文件.mjs');
  await writeFile(path.join(f.cwd, 'renamed 文件.mjs'), original + '// change\n'); f.git('add', '--', 'renamed 文件.mjs');
  const status = await gitTools(f.cwd).find(tool => tool.name === 'git_status').execute({});
  assert.equal(status.entries[0].original_path, '模块.mjs'); assert.equal(status.entries[0].path, 'renamed 文件.mjs');
  commit(); const head = f.git('rev-parse', 'HEAD').trim();
  await writeFile(path.join(f.cwd, 'renamed 文件.mjs'), 'uncommitted text is outside branch review\n');
  const { snapshot } = await f.request('snapshot', { scope: 'branch', baseRef: base });
  assert.equal(snapshot.headOid, head); assert.equal(snapshot.baseOid, base);
  assert.equal(snapshot.files.length, 1); assert.equal(snapshot.files[0].originalPath, '模块.mjs');
  assert.equal(snapshot.files[0].path, 'renamed 文件.mjs'); assert.equal(snapshot.files[0].oldText, original);
  assert.equal(snapshot.files[0].newText, original + '// change\n');
  const branches = await gitTools(f.cwd).find(tool => tool.name === 'git_branches').execute({});
  assert.equal(branches.branches.length, 1); assert.equal(branches.branches[0].current, true);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), head);
});

test('empty, excluded-only and timed-out execution have distinct truthful statuses', async t => {
  const f = await fixture(t, { timeoutMs: 25 });
  await writeFile(path.join(f.cwd, '模块.mjs'), 'export const sum = (a,b) => a+b;\n');
  let snapshot = (await f.request('snapshot', { scope: 'working_tree' })).snapshot;
  assert.equal((await f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'clean' })).result.status, 'no_changes');
  await writeFile(path.join(f.cwd, '.env'), 'OMITTED=1');
  snapshot = (await f.request('snapshot', { scope: 'working_tree' })).snapshot;
  assert.equal((await f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'excluded' })).result.status, 'no_reviewable_content');
  assert.equal(f.calls.length, 0);
  snapshot = (await f.request('snapshot', { scope: 'staged' })).snapshot;
  f.scripts.push(async ({ signal }) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); });
  const result = (await f.request('start', { snapshotId: snapshot.snapshotId, requestId: 'timed-out' })).result;
  const finished = (await finish(f, result.reviewId)).result;
  assert.equal(finished.status, 'failed'); assert.equal(finished.error.code, 'review_timeout');
});
