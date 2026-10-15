import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const SKILL_NAME = 'acceptance-ui-skill';
const DOWNLOADED_NAME = 'acceptance-downloaded-skill';
const OFFICIAL_SKILL_URL =
  'https://github.com/openai/skills/tree/main/skills/.system/skill-creator';
const ACCEPTANCE_WORKSPACE = join(tmpdir(), `codebuddy-skill-acceptance-${process.pid}`);
const PROJECT_SKILLS_ROOT = join(ACCEPTANCE_WORKSPACE, '.agents', 'skills');
mkdirSync(ACCEPTANCE_WORKSPACE, { recursive: true });

async function openSkillManager(page: Page) {
  await page.getByRole('button', { name: '工具箱', exact: true }).click();
  const tab = page.getByRole('tab', { name: '技能', exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '添加技能', exact: true })).toBeVisible();
}

function skillCard(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
}

async function openSkillDetails(page: Page, name: string) {
  await skillCard(page, name).getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name });
}

async function savePreview(page: Page) {
  const preview = page.getByRole('dialog', { name: '检查技能更改' });
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: '应用更改', exact: true }).click();
}

test.setTimeout(600_000);
test.use({ initialWorkingDir: ACCEPTANCE_WORKSPACE });
test.afterAll(() => rmSync(ACCEPTANCE_WORKSPACE, { recursive: true, force: true }));

test('Skills can be created, disabled, enabled, and used from the toolbox', async ({
  appPage,
}, testInfo) => {
  await openSkillManager(appPage);

  await appPage.getByRole('button', { name: '添加技能', exact: true }).click();
  let dialog = appPage.getByRole('dialog', { name: '新建技能' });
  await dialog.getByRole('textbox', { name: '技能名称' }).fill(SKILL_NAME);
  await dialog.getByRole('textbox', { name: '说明' }).fill('初始验收说明');
  await dialog.getByRole('textbox', { name: '技能指令' }).fill('回答时输出 SKILL_ACCEPTED。');
  await dialog.getByRole('button', { name: '检查更改', exact: true }).click();
  await savePreview(appPage);
  await expect(skillCard(appPage, SKILL_NAME)).toBeVisible();

  const skillPath = join(PROJECT_SKILLS_ROOT, SKILL_NAME, 'SKILL.md');
  await expect.poll(() => existsSync(skillPath)).toBe(true);
  expect(readFileSync(skillPath, 'utf8')).toContain('SKILL_ACCEPTED');

  dialog = await openSkillDetails(appPage, SKILL_NAME);
  await dialog.getByRole('button', { name: '停用', exact: true }).click();
  await savePreview(appPage);
  await expect(skillCard(appPage, SKILL_NAME)).toContainText('已停用');
  await expect
    .poll(() => existsSync(join(PROJECT_SKILLS_ROOT, SKILL_NAME, '.codebuddy-disabled')))
    .toBe(true);

  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  const disabledSkillInput = appPage.locator('[data-testid="chat-input"]:visible');
  await disabledSkillInput.fill('我需要按既定验收规则处理这项工作，请先参考相关技能。');
  await disabledSkillInput.press('Enter');
  await expect(appPage.getByText('SKILL_NOT_AVAILABLE', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });

  await openSkillManager(appPage);
  dialog = await openSkillDetails(appPage, SKILL_NAME);
  await dialog.getByRole('button', { name: '启用', exact: true }).click();
  await savePreview(appPage);
  await expect(skillCard(appPage, SKILL_NAME)).toContainText('可用');
  await expect
    .poll(() => existsSync(join(PROJECT_SKILLS_ROOT, SKILL_NAME, '.codebuddy-disabled')))
    .toBe(false);

  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  const input = appPage.locator('[data-testid="chat-input"]:visible');
  await input.fill('我需要按既定验收规则处理这项工作，请先参考相关技能。');
  await input.press('Enter');
  await expect(
    appPage.getByText('我需要按既定验收规则处理这项工作，请先参考相关技能。').last()
  ).toBeVisible();
  await expect(appPage.getByText('SKILL_USED', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });

  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  await appPage.getByRole('tab', { name: '技能', exact: true }).click();
  await expect(skillCard(appPage, SKILL_NAME)).toContainText('已成功使用 1 次');

  const screenshot = testInfo.outputPath('skill-enabled-and-used.png');
  await appPage.screenshot({ path: screenshot, fullPage: true });
  const evidence = testInfo.outputPath('skill-toggle-evidence.json');
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        skillName: SKILL_NAME,
        disabledConversationResult: 'SKILL_NOT_AVAILABLE',
        enabledConversationResult: 'SKILL_USED',
        usageCount: 1,
        disabledMarkerPersisted: false,
      },
      null,
      2
    ),
    'utf8'
  );
  await testInfo.attach('skill-toggle-evidence', {
    path: evidence,
    contentType: 'application/json',
  });
  await testInfo.attach('skill-enabled-and-used', {
    path: screenshot,
    contentType: 'image/png',
  });
});

test('Skills Download installs an official GitHub skill after preview', async ({ appPage }) => {
  await openSkillManager(appPage);
  await appPage.getByRole('button', { name: '从链接下载', exact: true }).click();
  const dialog = appPage.getByRole('dialog', { name: '从链接下载' });
  await dialog.getByRole('textbox', { name: '技能名称' }).fill(DOWNLOADED_NAME);
  await dialog
    .getByRole('textbox', { name: 'GitHub 技能目录或 HTTPS SKILL.md 链接' })
    .fill(OFFICIAL_SKILL_URL);
  await dialog.getByRole('button', { name: '检查更改', exact: true }).click();
  await savePreview(appPage);
  await expect(skillCard(appPage, DOWNLOADED_NAME)).toBeVisible({ timeout: 120_000 });

  const downloadedSkill = join(PROJECT_SKILLS_ROOT, DOWNLOADED_NAME, 'SKILL.md');
  await expect.poll(() => existsSync(downloadedSkill)).toBe(true);
  expect(readFileSync(downloadedSkill, 'utf8')).toContain(`name: ${DOWNLOADED_NAME}`);
  expect(
    readFileSync(join(PROJECT_SKILLS_ROOT, DOWNLOADED_NAME, '.codebuddy-source.json'), 'utf8')
  ).toContain(OFFICIAL_SKILL_URL);

  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  const downloadedCard = skillCard(appPage, DOWNLOADED_NAME);
  await expect(downloadedCard).toContainText('可用');
  await downloadedCard.click();
  const details = appPage.getByRole('dialog', { name: DOWNLOADED_NAME });
  await expect(details).toContainText('SKILL.md');
  await details.getByRole('button', { name: '关闭', exact: true }).first().click();

  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  const input = appPage.locator('[data-testid="chat-input"]:visible');
  const naturalQuestion = '我想创建一个可复用的新技能，应该怎样规划 SKILL.md 和配套文件？';
  await input.fill(naturalQuestion);
  await input.press('Enter');
  await expect(appPage.getByText(naturalQuestion, { exact: true })).toBeVisible();
  await expect(appPage.getByText('DOWNLOADED_SKILL_USED', { exact: true })).toBeVisible({
    timeout: 120_000,
  });
});
