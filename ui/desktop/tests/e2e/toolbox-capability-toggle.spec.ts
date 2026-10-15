import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

type Capability = {
  id: string;
  name: string;
  initiallyEnabled: boolean;
  locked?: boolean;
};

const CAPABILITIES: Capability[] = [
  { id: 'analyze', name: '代码分析', initiallyEnabled: true },
  { id: 'apps', name: '小工具', initiallyEnabled: true },
  { id: 'computer', name: '电脑控制', initiallyEnabled: true },
  { id: 'code_execution', name: '代码模式', initiallyEnabled: false },
  { id: 'developer', name: '开发工具', initiallyEnabled: true, locked: true },
  { id: 'skills', name: '技能', initiallyEnabled: true },
  { id: 'chatrecall', name: '历史对话检索', initiallyEnabled: true },
  { id: 'extensionmanager', name: '扩展管理', initiallyEnabled: true, locked: true },
  { id: 'git', name: 'Git 版本控制', initiallyEnabled: true },
  { id: 'summon', name: '任务委派', initiallyEnabled: true },
  { id: 'summarize', name: '内容摘要', initiallyEnabled: false },
  { id: 'todo', name: '任务清单', initiallyEnabled: true },
  { id: 'computercontroller', name: '计算机控制', initiallyEnabled: false },
  { id: 'autovisualiser', name: '自动可视化', initiallyEnabled: false },
  { id: 'memory', name: '记忆', initiallyEnabled: false },
  { id: 'tutorial', name: '教程', initiallyEnabled: false },
  { id: 'tom', name: '常驻上下文', initiallyEnabled: true },
];

const OPTIONAL_CAPABILITIES = CAPABILITIES.filter((capability) => !capability.locked);
const TEST_WORKSPACE = resolve(process.cwd(), '..', '..');

function cardFor(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
}

async function openCapabilities(page: Page) {
  await page.getByRole('button', { name: '工具箱', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工具箱', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '内置能力', exact: true }).click();
}

async function setCapability(page: Page, capability: Capability, enabled: boolean) {
  const control = cardFor(page, capability.name).getByRole('switch');
  if ((await control.isChecked()) !== enabled) await control.click();
  await expect(control).toBeChecked({ checked: enabled });
}

function expectedMatrix(overrides: Readonly<Record<string, boolean>> = {}): string {
  return `TOOLBOX_MATRIX ${CAPABILITIES.map(
    (capability) =>
      `${capability.id}=${(overrides[capability.id] ?? capability.initiallyEnabled) ? 1 : 0}`
  ).join(' ')}`;
}

function expectedToggledMatrix(capability: Capability, changedToEnabled: boolean): string {
  const overrides: Record<string, boolean> = { [capability.id]: changedToEnabled };
  if (capability.id === 'code_execution' && changedToEnabled) {
    Object.assign(overrides, {
      apps: false,
      chatrecall: false,
      extensionmanager: false,
      todo: false,
    });
  }
  return expectedMatrix(overrides);
}

async function probeConversation(page: Page, expected: string) {
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  const input = page.locator('[data-testid="chat-input"]:visible');
  await input.fill('工具箱全部能力开关探测');
  await input.press('Enter');
  await expect(page.getByText(expected, { exact: true }).last()).toBeVisible({ timeout: 120_000 });
}

test.setTimeout(900_000);
test.use({ initialWorkingDir: TEST_WORKSPACE });

test('Toolbox capability switches control every new-conversation capability', async ({
  appPage,
}, testInfo) => {
  await openCapabilities(appPage);
  await expect(appPage.getByText('CodeBuddy 文档指南', { exact: true })).toHaveCount(0);
  await expect(appPage.getByText('goose-doc-guide', { exact: true })).toHaveCount(0);

  for (const capability of CAPABILITIES) {
    const control = cardFor(appPage, capability.name).getByRole('switch');
    await expect(control).toHaveCount(1);
    await expect(control).toBeChecked({ checked: capability.initiallyEnabled });
    if (capability.locked) await expect(control).toBeDisabled();
    else await expect(control).toBeEnabled();
  }
  const capabilitySection = appPage.locator('section').filter({
    has: appPage.getByRole('heading', { name: '内置能力', exact: true }),
  });
  const visibleCapabilityNames = await capabilitySection
    .locator(':scope > div.grid > [data-slot="card"] > div > button[aria-label]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(visibleCapabilityNames.sort()).toEqual(CAPABILITIES.map(({ name }) => name).sort());

  await probeConversation(appPage, expectedMatrix());
  const defaultScreenshot = testInfo.outputPath('default-capabilities.png');
  await appPage.screenshot({ path: defaultScreenshot, fullPage: true });

  const toggleEvidence: Array<{
    capabilityId: string;
    changedToEnabled: boolean;
    matrix: string;
    screenshot: string;
  }> = [];
  for (const capability of OPTIONAL_CAPABILITIES) {
    await openCapabilities(appPage);
    const changedToEnabled = !capability.initiallyEnabled;
    await setCapability(appPage, capability, changedToEnabled);
    const matrix = expectedToggledMatrix(capability, changedToEnabled);
    await probeConversation(appPage, matrix);
    const screenshot = testInfo.outputPath(
      `${capability.id}-${changedToEnabled ? 'enabled' : 'disabled'}.png`
    );
    await appPage.screenshot({ path: screenshot, fullPage: true });
    toggleEvidence.push({ capabilityId: capability.id, changedToEnabled, matrix, screenshot });

    await openCapabilities(appPage);
    await setCapability(appPage, capability, capability.initiallyEnabled);
  }
  await probeConversation(appPage, expectedMatrix());

  const evidencePath = testInfo.outputPath('toolbox-capability-toggle-evidence.json');
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        capabilities: CAPABILITIES,
        toggleEvidence,
        defaultMatrix: expectedMatrix(),
        restoredInitialState: true,
        screenshots: { default: defaultScreenshot },
      },
      null,
      2
    ),
    'utf8'
  );
  await testInfo.attach('toolbox-capability-toggle-evidence', {
    path: evidencePath,
    contentType: 'application/json',
  });
  await testInfo.attach('default-capabilities', {
    path: defaultScreenshot,
    contentType: 'image/png',
  });
});
