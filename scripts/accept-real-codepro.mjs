import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openStore } from '../runtime/store.mjs';
import { createCompatServer } from '../runtime/server.mjs';
import { workspaceIdentity } from '../runtime/workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(path.join(root, '.preview-data', 'backend', 'state.json'), 'utf8'));
if (!source.defaults?.providerId || !source.defaults?.modelId) throw Error('Configure the preview model before real acceptance');
const profile = await mkdtemp(path.join(root, '.preview-evidence', 'real-codepro-'));
const cwd = path.join(profile, 'multi-module-project');
const store = await openStore(path.join(profile, 'backend'));
await store.update(state => { state.providers = source.providers; state.defaults = source.defaults; state.preferences = { gooseMode: 'approve', gooseMaxTurns: 40 }; });
const secret = randomUUID();
const app = await createCompatServer({ dataDir: store.directory, secret });
const url = await app.listen();
const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const pending = new Map(); const snapshots = []; const permissions = []; let sequence = 0;
ws.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data));
  if (pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(Error(message.error.message)) : p.resolve(message.result); return; }
  if (message.method?.endsWith('codepro/run/update')) { snapshots.push(message.params.snapshot); console.log(JSON.stringify({ phase: message.params.snapshot.state, sequence: message.params.snapshot.lastSequence, tasks: message.params.snapshot.tasks?.map(t => ({ id: t.taskId, state: t.state })) })); }
  if (message.method === 'session/request_permission') {
    const call = message.params.toolCall; const input = call.rawInput ?? {};
    const local = target => typeof target !== 'string' || path.resolve(cwd, target).startsWith(cwd + path.sep) || path.resolve(cwd, target) === cwd;
    const allowed = ['read', 'write', 'edit', 'glob', 'grep', 'ls', 'pwsh', 'bash', 'project_memory', 'todo'].includes(call.title) && local(input.file_path ?? input.path);
    permissions.push({ tool: call.title, allowed }); console.log(JSON.stringify({ tool: call.title, allowed }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: allowed ? 'allow_once' : 'reject_once' } } }));
  }
});
const request = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
const ext = name => `_goose/unstable/${name}`;
const receipt = { startedAt: new Date().toISOString(), profile, cwd, model: source.defaults.modelId, status: 'running', type: 'real-provider ACP and official Harness; desktop not part of this receipt' };
await writeFile(path.join(root, '.preview-evidence', 'real-codepro-latest.json'), JSON.stringify(receipt, null, 2));
let timeout;
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const lease = await request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const session = await request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: [{ type: 'builtin', name: 'developer' }] } });
  receipt.sessionId = session.sessionId;
  timeout = setTimeout(() => { receipt.timedOut = true; void request('session/cancel', { sessionId: session.sessionId }); }, 9 * 60_000);
  const prompt = `在当前隔离工作区 ${cwd} 完成一个无第三方依赖的 JavaScript 多模块项目，用于真实开发验收。不要操作目录外的文件，不访问网络，不安装依赖，不提交 Git。实现 packages/money/index.mjs（整数分金额加总、拒绝非安全整数）、packages/invoice/index.mjs（调用 money 模块计算购物清单总金额和按整数百分比折扣）、tests/project.test.mjs（至少覆盖空清单、正常金额、负数金额策略、小数或非整数输入、折扣边界），以及 package.json。使用 codebuddy_task 创建并完成实施与验证任务，规划后开始 task 再执行工具。直接调用文件工具写代码，然后用 pwsh 执行 & '${process.execPath.replaceAll("'", "''")}' --test tests/project.test.mjs 取得真实退出码。检查 inspect 返回的 evidenceIds，提交对应任务结果，再 propose_finish。保持工作范围小且完整，使用主 Agent 顺序执行，无需子 Agent。仅在验证实际通过后报告完成。`;
  receipt.promptResult = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
  const test = spawnSync(process.execPath, ['--test', 'tests/project.test.mjs'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  await writeFile(path.join(profile, 'independent-tests.log'), `${test.stdout ?? ''}\n${test.stderr ?? ''}`);
  receipt.independentTestsExit = test.status;
  receipt.run = snapshots.at(-1);
  receipt.permissions = permissions;
  receipt.status = receipt.run?.state === 'completed' && test.status === 0 ? 'passed' : receipt.timedOut ? 'interrupted' : 'incomplete';
} catch (error) { receipt.status = 'error'; receipt.error = error.message; }
finally {
  clearTimeout(timeout); ws.close(); await app.close(); receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(profile, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await writeFile(path.join(root, '.preview-evidence', 'real-codepro-latest.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, model: receipt.model, profile, independentTestsExit: receipt.independentTestsExit, error: receipt.error }));
  if (receipt.status !== 'passed') process.exitCode = 1;
}
