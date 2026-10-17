#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'ui', 'desktop');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, '.preview-data', 'reports', 'retest-20261016-script', runId);
const suite = (kind, files, extra = []) => ({ kind, files, extra });
const groups = {
  context: suite('ui', ['src/components/bottom_menu/ContextWindowIndicator.test.tsx']),
  timeline: suite('ui', ['src/components/ProgressiveMessageList.test.tsx']),
  editor: suite('ui', ['src/components/UserMessage.test.tsx']),
  editController: suite('ui', ['src/acp/__tests__/chatSessionController.test.ts'], ['--testNamePattern', 'updateMessage']),
  nativeEdit: suite('node', ['runtime/tests/conversation-editing.test.mjs', 'runtime/tests/conversation-editing-acp.test.mjs']),
  cancellation: suite('node', ['runtime/tests/cancelled-subagent-retest.test.mjs']),
  queue: suite('ui', ['src/components/ChatInput.queue.test.tsx']),
  modeUi: suite('ui', ['src/components/SessionPermissionSummary.test.tsx']),
  modeAcp: suite('node', ['runtime/tests/acp-contract.test.mjs'], ['--test-name-pattern', 'retest-20261016']),
  profile: suite('ui', ['src/storage/packagedProfile.test.ts', 'src/storage/codeBuddyPaths.test.ts']),
  terminal: suite('ui', ['src/components/GooseMessage.handoff.test.tsx']),
  silence: suite('ui', ['src/components/codepro/useWorkStatus.test.tsx']),
};
const issues = [
  [1, '上下文用量不显示约等号', ['context']],
  [2, '连续工具批次统一折叠，公开正文才分组', ['timeline']],
  [3, '移除分叉按钮', ['editor']],
  [4, '编辑原请求并重新生成', ['editor', 'editController', 'nativeEdit']],
  [5, '移除编辑区分叉提示', ['editor']],
  [6, '失败发送历史不阻断后续编辑', ['nativeEdit']],
  [7, '内部子 Agent 状态查询不刷主界面', ['timeline']],
  [8, '取消后的子任务通知不重新调用模型', ['cancellation']],
  [9, '立即发送等待旧请求结束且只提交一次', ['queue']],
  [10, '队列不再有展开层', ['queue']],
  [11, '生成中切换权限，下轮才生效', ['modeUi', 'modeAcp']],
  [12, '默认目录改名和数据兼容', ['profile']],
  [13, '宿主不追加未经证实的完成判词', ['terminal']],
  [14, '长静默反馈保留真实时间和状态', ['silence']],
].map(([id, title, checks]) => ({ id, title, checks }));
const limits = {
  1: '验证组件输出，不校准模型计费或 Token 估算。',
  2: '验证 React 组件和回放数据；不包含 Electron 像素、滚动或真实流式服务时序。',
  7: '验证成功查询投影及错误保留；不保证真实模型永不轮询或自动选择合理的 Agent 数量。',
  8: '使用本机模拟模型和真实原生子 Agent 生命周期；不调用外部模型或用户会话。',
  11: '验证真实 ACP 接口和请求权限快照，执行核心由隔离受控 Driver 驱动。',
  12: '只迁移随机临时目录的合成文件，不迁移真实用户目录，也不验证安装包启动。',
  13: '验证界面不越权下结论；wind 的真实停止原因仍缺原生日志。',
  14: '验证静默反馈；wind 的 84 秒等待原因仍缺原生和传输日志。',
};
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function identity() {
  const files = [...new Set([...git('diff', '--name-only').split(/\r?\n/), ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/)].filter(Boolean))].sort();
  return { root, branch: git('branch', '--show-current'), revision: git('rev-parse', 'HEAD'), dirtyFiles: files.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })) };
}
function escape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
const results = { startedAt: new Date().toISOString(), output, source: identity(), level: 'component and isolated protocol integration; no CU or desktop E2E', groups: {}, issues: [] };
function save() {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  const rows = results.issues.map(issue => '<tr><td>' + issue.id + '</td><td>' + escape(issue.title) + '</td><td>' + issue.status + '</td><td>' + issue.checks.map(name => '<a href="' + name + '.log">' + name + '</a>').join(' · ') + '</td><td>' + escape(issue.limit ?? '组件与接口脚本验证，未执行桌面人工验收。') + '</td></tr>').join('');
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>逐项脚本验证</title><style>body{font:16px/1.7 system-ui;margin:30px;color:#202936}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #dce2eb;text-align:left;vertical-align:top}th{background:#eef3fb}code{overflow-wrap:anywhere}</style><h1>CodeBuddy 逐项脚本验证</h1><p>本报告验证组件行为和隔离协议链路，不使用 CU，不代表桌面产品 E2E。</p><p>分支：' + escape(results.source.branch) + '；源码：<code>' + results.source.revision + '</code> + 未提交改动。测试结果与日志绑定此源码快照。</p><table><tr><th>序号</th><th>问题</th><th>脚本结果</th><th>日志</th><th>覆盖边界</th></tr>' + rows + '</table><p><a href="results.json">完整结果、用例数、命令与源码身份</a></p></html>');
}
async function runGroup(name) {
  const spec = groups[name];
  const logFile = path.join(output, name + '.log');
  let args, cwd;
  if (spec.kind === 'ui') {
    const cli = path.join(path.dirname(require.resolve('vitest/package.json', { paths: [desktop] })), 'vitest.mjs');
    args = [cli, 'run', '--maxWorkers=1', ...spec.files, ...spec.extra, '--reporter=json', '--outputFile', path.join(output, name + '.json')];
    cwd = desktop;
  } else {
    args = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...spec.extra, ...spec.files];
    cwd = root;
  }
  const started = Date.now();
  const log = fs.createWriteStream(logFile, { flags: 'wx' });
  let timedOut = false;
  const outcome = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch { child.kill(); }
      } else child.kill('SIGTERM');
    }, 180_000);
    child.once('error', error => { log.write(String(error)); });
    child.once('close', (code, signal) => { clearTimeout(timeout); log.end(() => resolve({ exitCode: code, signal })); });
  });
  let counts = { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 }, failures = [], suiteErrors = [];
  if (spec.kind === 'ui' && fs.existsSync(path.join(output, name + '.json'))) {
    const report = JSON.parse(fs.readFileSync(path.join(output, name + '.json'), 'utf8'));
    counts = { tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, cancelled: 0 };
    suiteErrors = report.testResults.filter(file => file.status === 'failed' && file.message).map(file => ({ file: file.name, message: file.message }));
    failures = report.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => ({ name: test.fullName, messages: test.failureMessages })));
  } else if (spec.kind === 'node') {
    const text = fs.readFileSync(logFile, 'utf8');
    for (const [field, label] of [['tests', 'tests'], ['passed', 'pass'], ['failed', 'fail'], ['skipped', 'skipped'], ['cancelled', 'cancelled']]) {
      const hits = [...text.matchAll(new RegExp('^# ' + label + ' (\\d+)', 'gm'))];
      counts[field] = Number(hits.at(-1)?.[1] ?? 0);
    }
  }
  return { ...outcome, status: outcome.exitCode === 0 && !timedOut && counts.tests > 0 ? 'PASS' : 'FAIL', timedOut, durationMs: Date.now() - started, counts, failures, suiteErrors, command: [process.execPath, ...args], cwd, log: logFile };
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const onlyArg = process.argv.slice(2).find(arg => arg.startsWith('--only='));
  const selected = onlyArg ? new Set(onlyArg.slice(7).split(',').map(Number)) : null;
  if (selected && [...selected].some(id => !Number.isInteger(id) || id < 1 || id > 14)) throw new Error('--only requires issue numbers 1..14');
  for (const issue of issues.filter(item => !selected || selected.has(item.id))) {
    console.log('[' + issue.id + '/14] ' + issue.title);
    for (const name of issue.checks) {
      if (!results.groups[name]) {
        console.log('  RUN ' + name);
        results.groups[name] = await runGroup(name);
        console.log('  ' + results.groups[name].status + ' ' + name + ' ' + JSON.stringify(results.groups[name].counts));
      } else console.log('  REUSE ' + name + ': ' + results.groups[name].status);
    }
    results.issues.push({ ...issue, status: issue.checks.every(name => results.groups[name].status === 'PASS') ? 'PASS' : 'FAIL', limit: limits[issue.id] });
    save();
  }
  results.finishedAt = new Date().toISOString();
  results.sourceAfter = identity();
  results.sourceUnchangedDuringRun = JSON.stringify(results.source) === JSON.stringify(results.sourceAfter);
  results.summary = { issues: results.issues.length, passed: results.issues.filter(issue => issue.status === 'PASS').length, failed: results.issues.filter(issue => issue.status === 'FAIL').length, uniqueGroups: Object.keys(results.groups).length, tests: Object.values(results.groups).reduce((sum, group) => sum + group.counts.tests, 0), passedTests: Object.values(results.groups).reduce((sum, group) => sum + group.counts.passed, 0), failedTests: Object.values(results.groups).reduce((sum, group) => sum + group.counts.failed, 0) };
  save();
  console.log(JSON.stringify({ summary: results.summary, sourceUnchangedDuringRun: results.sourceUnchangedDuringRun, report: path.join(output, 'index.html') }, null, 2));
  process.exitCode = results.summary.failed || !results.sourceUnchangedDuringRun ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
