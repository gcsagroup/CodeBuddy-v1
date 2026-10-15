import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './qualification-fixtures';

test.setTimeout(480_000);

async function startTask(appPage: Page, workspace: string, prompt: string) {
  await expect
    .poll(() => appPage.evaluate(() => window.appConfig?.get('REQUEST_DIR')))
    .toBe(workspace);
  const unboundDirectory = appPage.getByRole('button', { name: '请选择目录' });
  await expect(unboundDirectory).toBeVisible();
  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  await unboundDirectory.click();
  await appPage.getByRole('menuitem').filter({ hasText: 'UserProject' }).click();
  await expect(appPage.getByRole('button', { name: 'UserProject' })).toBeVisible();
  const input = appPage.getByTestId('chat-input');
  await input.fill(prompt);
  await input.press('Enter');
  await expect(appPage.getByRole('heading', { name: '确认项目工作目录' })).toHaveCount(0);
  await expect(appPage.getByRole('heading', { name: '本次任务结果' })).toBeVisible({
    timeout: 180_000,
  });
}

async function expandActivities(appPage: Page) {
  const buttons = appPage.getByRole('button', { name: /^活动：/ });
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
  }
}

async function expandTechnicalEvidence(appPage: Page) {
  const summaries = appPage.locator('summary').filter({ hasText: '查看运行记录' });
  const count = await summaries.count();
  for (let index = 0; index < count; index += 1) {
    const summary = summaries.nth(index);
    if ((await summary.locator('..').getAttribute('open')) === null) await summary.click();
  }
}

function findFiles(root: string, fileName: string): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    if (statSync(candidate).isDirectory()) matches.push(...findFiles(candidate, fileName));
    else if (entry === fileName) matches.push(candidate);
  }
  return matches;
}

test('L1 edits one explicit file, validates it, and does not start Planner or Reviewer', async ({
  appPage,
  initialWorkingDir,
}) => {
  await startTask(
    appPage,
    initialWorkingDir,
    '把 `src/button.js` 里的按钮文字 old 替换成 new，然后运行最小相关测试'
  );
  await expandActivities(appPage);
  await expandTechnicalEvidence(appPage);

  expect(readFileSync(join(initialWorkingDir, 'src', 'button.js'), 'utf8')).toContain("'new'");
  await expect(appPage.getByText('L1 可逆修改', { exact: true })).toBeVisible();
  await expect(appPage.getByText(/终态：PASS/)).toBeVisible();
  await expect(appPage.getByText(/Planner/)).toHaveCount(0);
  await expect(appPage.getByText(/独立审查通过|独立审查未通过/)).toHaveCount(0);
});

test('L2 implements a route and controller, then an independent Tester validates host facts', async ({
  appPage,
  initialWorkingDir,
}) => {
  await startTask(
    appPage,
    initialWorkingDir,
    '实现问候路由和控制器功能并添加自动化测试，完成后独立验证'
  );
  await expandActivities(appPage);
  await expandTechnicalEvidence(appPage);

  expect(readFileSync(join(initialWorkingDir, 'src', 'controller.js'), 'utf8')).toContain('hello');
  expect(readFileSync(join(initialWorkingDir, 'src', 'route.js'), 'utf8')).toContain('status: 200');
  expect(existsSync(join(initialWorkingDir, 'tests', 'route.test.mjs'))).toBe(true);
  await expect(appPage.getByText(/执行级别：L2 普通功能/)).toBeVisible();
  await expect(appPage.getByText(/Reviewer：本级别不要求/)).toBeVisible();
  await expect(appPage.getByRole('button', { name: /^活动：.*Reviewer/ })).toHaveCount(0);
  await expect(appPage.getByText(/终态：PASS/)).toBeVisible();
  await expect(appPage.getByText('src/controller.js', { exact: true })).toBeVisible();
  await expect(appPage.getByText('src/route.js', { exact: true })).toBeVisible();
});

test('P0 repairs a real host test failure in a 2,000-file project and retests the identical command', async ({
  appPage,
  isolatedProfileRoot,
  initialWorkingDir,
}, testInfo) => {
  const scaleRoot = join(initialWorkingDir, 'packages');
  for (let packageIndex = 0; packageIndex < 100; packageIndex += 1) {
    const packageRoot = join(scaleRoot, `package-${packageIndex.toString().padStart(3, '0')}`);
    mkdirSync(packageRoot, { recursive: true });
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
      writeFileSync(
        join(packageRoot, `module-${fileIndex.toString().padStart(2, '0')}.js`),
        `export const value = ${packageIndex * 20 + fileIndex};\n`,
        'utf8'
      );
    }
  }
  await startTask(
    appPage,
    initialWorkingDir,
    '多文件修复：诊断加法模块和自动化测试的交互，完成后独立验证；必须先运行现有 node tests.js 复现 add_returns_four，保存失败证据，Coder 修改后再重跑同一命令'
  );
  await expandActivities(appPage);
  await expandTechnicalEvidence(appPage);

  await testInfo.attach('codepro-rendered-body', {
    body: await appPage.locator('body').innerText(),
    contentType: 'text/plain',
  });

  expect(readFileSync(join(initialWorkingDir, 'implementation.js'), 'utf8')).toContain(
    'return a + b;'
  );
  await expect(appPage.getByText(/终态：PASS/)).toBeVisible();
  await expect(appPage.getByText(/node tests\.js/).first()).toBeVisible();
  await expect(appPage.getByText(/PASS add_returns_four/).first()).toBeVisible();
  const liveRunStates = () =>
    findFiles(isolatedProfileRoot, 'state.json').filter((path) =>
      path.endsWith(join('run', 'state.json'))
    );
  await expect.poll(() => liveRunStates().length).toBeGreaterThan(0);
  const statePath = liveRunStates()[0];
  const stateBytes = readFileSync(statePath);
  await testInfo.attach('codepro-run-state', {
    body: stateBytes,
    contentType: 'application/json',
  });
  const state = JSON.parse(stateBytes.toString('utf8')) as {
    status: string;
    dag: {
      tasks: Array<{ id: string; status: string }>;
      verification_evidence_v1: Record<
        string,
        Array<{
          repairContext?: {
            retestHistory?: Array<{ outcome: string }>;
          };
        }>
      >;
    };
  };
  expect(
    state.status,
    JSON.stringify(
      {
        status: state.status,
        tasks: state.dag.tasks.map((task) => ({ id: task.id, status: task.status })),
      },
      null,
      2
    )
  ).toBe('completed');
  // The diagnostic Tester owns the authoritative RepairContext and same-command retest;
  // the planner's duplicate downstream Tester remains skipped for audit.
  expect(Object.fromEntries(state.dag.tasks.map((task) => [task.id, task.status]))).toMatchObject({
    diagnostic: 'done',
    code: 'done',
    'verify-code': 'skipped',
  });
  expect(
    state.dag.verification_evidence_v1.diagnostic[0].repairContext?.retestHistory?.map(
      (attempt) => attempt.outcome
    )
  ).toEqual(['verification_failed', 'succeeded']);
  await expect(
    appPage.getByText(/task_failure|repair_branch_unavailable|recovery_requires_user_scope/)
  ).toHaveCount(0);
  await expect(appPage.getByText('仍有限制', { exact: true })).toHaveCount(0);
});

test('L3 cannot report completion when independent Reviewer withholds approval', async ({
  appPage,
  initialWorkingDir,
}) => {
  await startTask(
    appPage,
    initialWorkingDir,
    '实现管理员权限开关并准备发布到远端；没有独立 Reviewer 批准不得宣告完成'
  );
  await expandActivities(appPage);
  await expandTechnicalEvidence(appPage);

  expect(readFileSync(join(initialWorkingDir, 'src', 'access.js'), 'utf8')).toContain('true');
  await expect(appPage.getByText(/执行级别：L3 高风险\/发布/)).toBeVisible();
  await expect(appPage.getByText(/Reviewer：未确认批准/)).toBeVisible();
  await expect(appPage.getByText(/独立审查未通过|Reviewer 未批准|终态：BLOCKED/)).toBeVisible();
  await expect(appPage.getByText(/终态：PASS/)).toHaveCount(0);
});
