import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';

const workspace = join(tmpdir(), `codepro-github-issues-e2e-${process.pid}`);
const fakeBin = join(tmpdir(), `codepro-github-issues-bin-${process.pid}`);
const stateFile = join(workspace, 'fake-github-issues.json');
const commandLog = join(workspace, 'fake-gh-commands.jsonl');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

const fakeGitHubCli = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const fixtureRoot = process.env.CODEPRO_E2E_WORKING_DIR || process.cwd();
const statePath = path.join(fixtureRoot, 'fake-github-issues.json');
const logPath = path.join(fixtureRoot, 'fake-gh-commands.jsonl');
fs.appendFileSync(logPath, JSON.stringify(args) + '\n');
function load() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function save(value) { fs.writeFileSync(statePath, JSON.stringify(value, null, 2)); }
function option(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
if (args[0] === '--version') {
  process.stdout.write('gh version 2.80.0 (fake)\n');
} else if (args[0] === 'auth' && args[1] === 'status') {
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'octocat', state: 'success' }] } }));
  }
} else if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]');
} else if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(load()));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const issue = load().find((candidate) => candidate.number === Number(args[2]));
  if (!issue) process.exit(1);
  process.stdout.write(JSON.stringify(issue));
} else if (args[0] === 'issue' && args[1] === 'create') {
  const issues = load();
  const number = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
  issues.push({ number, title: option('--title'), body: fs.readFileSync(0, 'utf8'), state: 'OPEN', url: 'https://github.com/octo/demo/issues/' + number });
  save(issues);
  process.stdout.write('https://github.com/octo/demo/issues/' + number + '\n');
} else if (args[0] === 'issue' && args[1] === 'edit') {
  const issues = load();
  const issue = issues.find((candidate) => candidate.number === Number(args[2]));
  if (!issue) process.exit(1);
  issue.title = option('--title');
  issue.body = fs.readFileSync(0, 'utf8');
  save(issues);
} else if (args[0] === 'issue' && (args[1] === 'close' || args[1] === 'reopen')) {
  const issues = load();
  const issue = issues.find((candidate) => candidate.number === Number(args[2]));
  if (!issue) process.exit(1);
  issue.state = args[1] === 'close' ? 'CLOSED' : 'OPEN';
  save(issues);
} else {
  process.stderr.write('unsupported fake gh arguments: ' + JSON.stringify(args));
  process.exit(1);
}
`;

test.use({ initialWorkingDir: workspace, executablePathPrefix: fakeBin });
test.setTimeout(480_000);

test.beforeAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  git('init', '-b', 'main');
  git('config', 'user.email', 'codepro-e2e@example.invalid');
  git('config', 'user.name', 'CodePro E2E');
  writeFileSync(join(workspace, 'README.md'), '# fixture\n', 'utf8');
  git('add', '.');
  git('commit', '-m', 'base');
  git('remote', 'add', 'origin', 'https://github.com/octo/demo.git');
  writeFileSync(
    stateFile,
    JSON.stringify(
      [
        {
          number: 7,
          title: 'Bounded issue',
          body: 'Current details.',
          state: 'OPEN',
          url: 'https://github.com/octo/demo/issues/7',
        },
      ],
      null,
      2
    ),
    'utf8'
  );
  const script = join(fakeBin, 'fake-gh.cjs');
  writeFileSync(script, fakeGitHubCli, 'utf8');
  if (process.platform === 'win32') {
    const launcher = join(fakeBin, 'fake-gh.rs');
    writeFileSync(
      launcher,
      [
        'use std::process::{Command, exit};',
        'fn main() {',
        '    let mut script = std::env::current_exe().expect("current executable");',
        '    script.set_file_name("fake-gh.cjs");',
        '    let status = Command::new("node")',
        '        .arg(script)',
        '        .args(std::env::args_os().skip(1))',
        '        .status()',
        '        .expect("start node");',
        '    exit(status.code().unwrap_or(1));',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    execFileSync('rustc', [launcher, '-o', join(fakeBin, 'gh.exe')]);
  } else {
    const executable = join(fakeBin, 'gh');
    writeFileSync(executable, '#!/usr/bin/env node\n' + fakeGitHubCli, 'utf8');
    chmodSync(executable, 0o755);
  }
});

test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

test('creates, edits, closes, and reopens Issues through the visible desktop workflow', async ({
  appPage,
}, testInfo) => {
  const home = appPage.getByRole('heading', { name: '我是 CodeBuddy，一起把事情做好。' });
  const codeProSwitch = appPage.getByRole('button', { name: 'CodePro', exact: true });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await home.isVisible().catch(() => false)) break;
    if (await codeProSwitch.isVisible().catch(() => false))
      await codeProSwitch.click().catch(() => {});
    await appPage.waitForTimeout(250);
  }
  await expect(home).toBeVisible();
  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  await appPage.getByRole('button', { name: '请选择目录' }).click();
  await appPage
    .getByRole('menuitem')
    .filter({ hasText: `codepro-github-issues-e2e-${process.pid}` })
    .click();
  await appPage.getByTestId('chat-input').fill('回复本地测试确认');
  await appPage.getByRole('button', { name: '发送' }).click();
  const workspaceConfirmation = appPage.getByRole('heading', {
    name: '选择这个对话所属的项目',
  });
  await expect(workspaceConfirmation).toBeVisible();
  await appPage.getByRole('button', { name: '使用这个文件夹', exact: true }).click();
  await expect(workspaceConfirmation).not.toBeVisible();
  await expect(appPage.getByText(/CodePro 本地测试响应：已收到请求。/u).last()).toBeVisible({
    timeout: 120_000,
  });
  await expect(appPage.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 120_000 });

  await appPage.getByRole('button', { name: '打开 CodePro 任务面板' }).click();
  const panel = appPage.getByRole('complementary', { name: 'CodePro 任务' });
  await panel.getByRole('button', { name: '拉取请求' }).click();
  await expect(panel.getByRole('heading', { name: '议题', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByText('Bounded issue')).toBeVisible();
  const dialog = appPage.getByRole('dialog');

  await panel.getByRole('button', { name: '创建 Issue' }).click();
  await dialog.getByRole('textbox', { name: 'Issue 标题' }).fill('New issue');
  await dialog.getByRole('textbox', { name: 'Issue 描述' }).fill('New details.');
  await dialog.getByRole('button', { name: '运行创建预检' }).click();
  await dialog.getByRole('button', { name: '在 GitHub 上创建' }).click();
  await expect(panel.getByText('New issue')).toBeVisible();

  await panel.getByRole('button', { name: '编辑 Issue #7' }).click();
  await dialog.getByRole('textbox', { name: 'Issue 标题' }).fill('Updated issue');
  await dialog.getByRole('textbox', { name: 'Issue 描述' }).fill('Updated details.');
  await dialog.getByRole('button', { name: '运行更新预检' }).click();
  await dialog.getByRole('button', { name: '在 GitHub 上更新' }).click();
  await expect(panel.getByText('Updated issue')).toBeVisible();

  await panel.getByRole('button', { name: '关闭 Issue #7' }).click();
  await dialog.getByRole('button', { name: '运行状态预检' }).click();
  await dialog.getByRole('button', { name: '在 GitHub 上关闭' }).click();
  await expect(panel.getByRole('button', { name: '重新打开 Issue #7' })).toBeVisible();
  await panel.getByRole('button', { name: '重新打开 Issue #7' }).click();
  await dialog.getByRole('button', { name: '运行状态预检' }).click();
  await dialog.getByRole('button', { name: '在 GitHub 上重新打开' }).click();
  await expect(panel.getByRole('button', { name: '关闭 Issue #7' })).toBeVisible();

  const commands = readFileSync(commandLog, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as string[]);
  expect(commands.some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(true);
  expect(commands.some((args) => args[0] === 'issue' && args[1] === 'edit')).toBe(true);
  expect(commands.flat().some((argument) => argument.includes('New details.'))).toBe(false);
  expect(commands.flat().some((argument) => argument.includes('Updated details.'))).toBe(false);
  await appPage.screenshot({
    path: testInfo.outputPath('codepro-github-issues.png'),
    fullPage: true,
  });
});
