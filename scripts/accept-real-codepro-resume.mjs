import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openStore } from '../runtime/store.mjs';
import { createCompatServer } from '../runtime/server.mjs';
import { workspaceIdentity } from '../runtime/workspaces.mjs';
import { CodeProRuns } from '../runtime/codepro.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = name => `_goose/unstable/${name}`;
export const projectFiles = ['packages/money/index.mjs', 'packages/invoice/index.mjs', 'tests/project.test.mjs', 'package.json'];
export function permissionDecision(cwd, command, title, input, { phase, checkpointRequested }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'deny';
  if (checkpointRequested && phase === 'initial') return 'deny';
  if (title === 'pwsh') {
    const sameDirectory = input.workdir === undefined || (typeof input.workdir === 'string' && path.resolve(cwd, input.workdir) === cwd);
    return phase === 'resumed' && input.command === command && sameDirectory && input.run_in_background !== true && input.background !== true && input.sandbox_permissions === undefined ? 'review' : 'deny';
  }
  const target = input.file_path ?? input.path;
  const local = typeof target === 'string' && !path.relative(cwd, path.resolve(cwd, target)).split(path.sep).includes('..') && !path.isAbsolute(path.relative(cwd, path.resolve(cwd, target)));
  if (['read', 'ls', 'glob', 'grep'].includes(title)) return local ? 'allow' : 'deny';
  const allowedFiles = phase === 'initial' ? projectFiles.slice(0, 1) : projectFiles.slice(1);
  if (['write', 'edit'].includes(title) && local && allowedFiles.some(file => path.resolve(cwd, file) === path.resolve(cwd, target))) return 'allow';
  return 'deny';
}
export function assertQuiescent(context) {
  assert.equal(context.state, 'paused');
  assert.equal(context.activeAttempt, null);
  assert.equal(context.recovery.pendingEffects, 0);
  assert.equal(context.recovery.uncertainEffects, 0);
  assert.ok(context.effects.every(effect => effect.state === 'completed' && !effect.requiresResolution));
}
export function assertPrefixPreserved(before, after) {
  assert.equal(after.runId, before.runId);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(new Set(after.events.map(event => event.eventId)).size, after.events.length);
  const beforeReceipts = before.events.filter(event => event.eventType === 'tool_result');
  for (const receipt of beforeReceipts) assert.equal(after.events.filter(event => event.eventId === receipt.eventId).length, 1);
}
async function fileEvidence(cwd, files = projectFiles) {
  return Promise.all(files.map(async file => ({ file, sha256: createHash('sha256').update(await readFile(path.join(cwd, file))).digest('hex'), mtimeMs: (await stat(path.join(cwd, file))).mtimeMs })));
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function acceptRealResume() {
  const source = JSON.parse(await readFile(path.join(root, '.preview-data', 'backend', 'state.json'), 'utf8'));
  const provider = source.providers?.find(row => row.id === source.defaults?.providerId);
  if (!provider || !source.defaults?.modelId) throw Error('Configure the preview default provider first');
  const evidenceRoot = path.join(root, '.preview-evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(path.join(evidenceRoot, 'real-codepro-resume-'));
  const cwd = path.join(profile, 'multi-module-project');
  const dataDir = path.join(profile, 'backend');
  const prepared = await openStore(dataDir);
  await prepared.update(state => { state.providers = [provider]; state.defaults = source.defaults; state.preferences = { gooseMode: 'approve', gooseMaxTurns: 48 }; });
  const command = `& '${process.execPath.replaceAll("'", "''")}' --test tests/project.test.mjs`;
  const receipt = { status: 'running', startedAt: new Date().toISOString(), profile, cwd, model: source.defaults.modelId, type: 'real-provider ACP pause, fresh server restart, same-run control resume; no Electron', permissions: [], phases: [] };
  const save = () => writeFile(path.join(profile, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await save();
  console.log(JSON.stringify({ status: 'started', profile, model: receipt.model }));
  let phase = 'initial', checkpointRequested = false, client, app, checkpoint, lastSnapshot, pauseJob;
  let checkpointResolve, checkpointReject;
  const checkpointDone = new Promise((resolve, reject) => { checkpointResolve = resolve; checkpointReject = reject; });
  checkpointDone.catch(() => {});
  let stopped = false;
  const started = Date.now(), deadline = started + 9 * 60_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  async function facts() {
    const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    const run = state.codeproRuns?.find(row => row.runId === receipt.runId);
    if (!run) throw Error('Expected CodePro run is missing');
    return { run, context: new CodeProRuns({ read: () => state }).context({ sessionId: receipt.sessionId, runId: receipt.runId }) };
  }
  async function approveReviewedSources() {
    const current = await fileEvidence(cwd);
    await writeFile(path.join(profile, 'review-pending.json'), JSON.stringify({ cwd, files: current }, null, 2));
    console.log(JSON.stringify({ status: 'source_review_required', profile, files: projectFiles }));
    while (!stopped && Date.now() < deadline) {
      try {
        const reviewed = JSON.parse(await readFile(path.join(profile, 'source-review.json'), 'utf8'));
        const latest = await fileEvidence(cwd);
        if (reviewed.cwd === cwd && JSON.stringify(reviewed.files) === JSON.stringify(current) && JSON.stringify(latest) === JSON.stringify(current)) return true;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(500);
    }
    return false;
  }
  async function connect() {
    const secret = randomUUID();
    app = await createCompatServer({ dataDir, secret });
    const url = await app.listen();
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const pending = new Map(); let sequence = 0;
    const connection = { close: () => ws.close(), request(method, params = {}) { return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(Error('Acceptance deadline reached'), { code: 'ACCEPTANCE_TIMEOUT' })); }, remaining());
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    }); } };
    ws.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('ACP connection closed')); } pending.clear(); });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      const item = pending.get(message.id);
      if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Object.assign(Error(message.error.message), { code: message.error.code })) : item.resolve(message.result); return; }
      if (message.method === ext('codepro/run/update')) {
        lastSnapshot = message.params.snapshot;
        receipt.runId ??= lastSnapshot.runId;
        console.log(JSON.stringify({ phase, state: lastSnapshot.state, sequence: lastSnapshot.lastSequence, tasks: lastSnapshot.tasks.map(task => ({ id: task.taskId, state: task.state })) }));
        if (phase === 'initial' && !checkpointRequested && lastSnapshot.tasks.some(task => task.taskId === 'money' && task.state === 'succeeded')) {
          checkpointRequested = true;
          const triggerSequence = lastSnapshot.lastSequence;
          pauseJob = (async () => {
            const trigger = await facts();
            const writes = trigger.context.receipts.filter(item => item.kind === 'write' && item.outcome === 'succeeded');
            assert.equal(writes.length, 1); assert.equal(writes[0].path, path.join(cwd, projectFiles[0]));
            receipt.trigger = { sequence: triggerSequence, receiptEventId: writes[0].eventId, receiptSequence: writes[0].sequence };
            await connection.request(ext('codepro/run/control'), { schemaVersion: 1, sessionId: receipt.sessionId, runId: receipt.runId, commandId: randomUUID(), action: { type: 'pause_run', reason: 'Acceptance checkpoint after the first verified native file write and completed money task' } });
            checkpoint = await facts(); assertQuiescent(checkpoint.context);
            checkpoint.files = await fileEvidence(cwd, [projectFiles[0]]);
            receipt.checkpoint = { context: checkpoint.context, files: checkpoint.files };
            receipt.phases.push({ phase: 'paused', at: new Date().toISOString(), sequence: checkpoint.context.lastSequence });
            await save(); checkpointResolve();
          })().catch(error => { checkpointReject(error); });
        }
      }
      if (message.method === 'session/request_permission') void (async () => {
        const call = message.params.toolCall, input = call.rawInput ?? {};
        const decision = permissionDecision(cwd, command, call.title, input, { phase, checkpointRequested });
        const allowed = decision === 'allow' || (decision === 'review' && await approveReviewedSources());
        receipt.permissions.push({ phase, tool: call.title, allowed, reason: decision, ...(call.title === 'pwsh' ? { workdir: input.workdir ?? cwd, runInBackground: input.run_in_background ?? false } : {}) });
        console.log(JSON.stringify({ phase, tool: call.title, allowed }));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: allowed ? 'allow_once' : 'reject_once' } } }));
      })().catch(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } })); });
    });
    client = connection;
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  }
  const timeout = setTimeout(() => { stopped = true; receipt.timedOut = true; if (receipt.sessionId) void client?.request('session/cancel', { sessionId: receipt.sessionId }).catch(() => {}); }, remaining());
  try {
    await connect();
    let lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
    const session = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: [{ type: 'builtin', name: 'developer' }] } });
    receipt.sessionId = session.sessionId;
    const prompt = `在当前隔离工作区 ${cwd} 开发一个零第三方依赖的 JavaScript 多模块项目，验收暂停、后端重启和原任务继续。所有文件都限当前目录，不访问网络、不安装依赖、不运行 Git，不使用子 Agent。完整目标：packages/money/index.mjs 提供 addAmounts，整数分金额加总，空数组为 0，允许负数但拒绝非安全整数及溢出；packages/invoice/index.mjs 调用 money 计算购物清单金额和整数百分比折扣（0..100，向下取整到分）；tests/project.test.mjs 用 node:test 和 node:assert/strict 覆盖空清单、正常和负数金额、非法/溢出输入、折扣边界，至少 8 项；package.json。只有这四个文件允许写入。先用 codebuddy_task submit_plan 建立三个任务，ID 固定 money（implementation）、invoice-tests（implementation，依赖 money）、verification（verification，依赖 invoice-tests）。第一阶段只 start_task money 并 write packages/money/index.mjs；inspect 真实回执并用 evidenceIds 提交 money succeeded，然后停止工具动作、文字回复等待暂停。宿主会用 pause_run、关闭服务器、重新加载并 resume_run。恢复后 inspect 现有计划与证据，保持 money 已完成且禁止重写它，接着完成 invoice-tests 和 verification，使用唯一允许命令 ${command} 取得真实测试退出码并提交通关证据，然后 propose_finish。恢复指令表示此处的第一阶段暂停已完成，请直接完成剩余目标。测试命令需要源码检查审批，等待审批即可。不要把模型自述当测试结果。`;
    const firstPrompt = client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
    firstPrompt.catch(() => {});
    await Promise.race([checkpointDone, firstPrompt.then(() => { if (!pauseJob) throw Error('Model ended before the required checkpoint'); return checkpointDone; })]);
    receipt.initialPrompt = await firstPrompt;
    await pauseJob;
    client.close(); await app.close(); app = null;
    const afterClose = await facts(); assertQuiescent(afterClose.context); assertPrefixPreserved(checkpoint.run, afterClose.run);
    phase = 'resumed';
    await connect();
    lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'non-empty-directory', expectedIdentity: workspaceIdentity(cwd) });
    await client.request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [], _meta: { workspaceLeaseId: lease.leaseId } });
    const restored = await facts(); assertQuiescent(restored.context); assert.deepEqual(restored.run.events, afterClose.run.events);
    receipt.restart = { sameRunId: restored.run.runId, exactEventPrefix: true, sequence: restored.context.lastSequence };
    await client.request(ext('codepro/run/control'), { schemaVersion: 1, sessionId: session.sessionId, runId: receipt.runId, expectedSequence: restored.context.lastSequence, commandId: randomUUID(), action: { type: 'resume_run' } });
    receipt.phases.push({ phase: 'resumed', at: new Date().toISOString() });
    while (!stopped && Date.now() < deadline) {
      const current = await facts();
      if (!current.context.activeAttempt && current.context.state === 'completed') break;
      if (!current.context.activeAttempt && current.context.state === 'paused' && current.run.events.some(event => event.eventType === 'attempt_started' && event.sequence > restored.context.lastSequence)) throw Error('Resumed model stopped before completion; saved state remains resumable');
      await delay(500);
    }
    const finished = await facts();
    receipt.run = finished.context;
    if (stopped) throw Object.assign(Error('Acceptance deadline reached; persisted state retained'), { code: 'ACCEPTANCE_TIMEOUT' });
    assert.equal(finished.context.state, 'completed');
    assert.equal(finished.context.activeAttempt, null);
    assert.equal(finished.context.recovery.pendingEffects, 0); assert.equal(finished.context.recovery.uncertainEffects, 0);
    assertPrefixPreserved(checkpoint.run, finished.run);
    assert.deepEqual(await fileEvidence(cwd, [projectFiles[0]]), checkpoint.files);
    assert.equal(finished.context.receipts.filter(item => item.kind === 'write' && item.path === path.join(cwd, projectFiles[0])).length, 1);
    const approval = JSON.parse(await readFile(path.join(profile, 'source-review.json'), 'utf8'));
    assert.deepEqual(await fileEvidence(cwd), approval.files);
    const test = spawnSync(process.execPath, ['--test', 'tests/project.test.mjs'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    await writeFile(path.join(profile, 'independent-tests.log'), `${test.stdout ?? ''}\n${test.stderr ?? ''}`);
    receipt.independentTestsExit = test.status; assert.equal(test.status, 0);
    receipt.continuity = { originalEventsPreserved: true, originalReceiptUnique: true, originalFileHashAndMtimeUnchanged: true, sameRunCompleted: true };
    receipt.status = 'passed';
  } catch (error) { receipt.status = error.code === 'ACCEPTANCE_TIMEOUT' || receipt.timedOut ? 'interrupted' : 'incomplete'; receipt.error = String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1000); }
  finally {
    stopped = true; clearTimeout(timeout);
    client?.close(); await app?.close();
    try { receipt.finalContext = (await facts()).context; } catch {}
    receipt.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: receipt.status, profile, runId: receipt.runId, independentTestsExit: receipt.independentTestsExit, error: receipt.error }));
  }
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await acceptRealResume();
  if (receipt.status !== 'passed') process.exitCode = 1;
}
