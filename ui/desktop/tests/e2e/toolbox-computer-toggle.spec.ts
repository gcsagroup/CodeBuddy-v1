import { writeFileSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

test.setTimeout(600_000);
const TEST_WORKSPACE = resolve(process.cwd(), '..', '..');
const ROOT_CONTAINER = parse(TEST_WORKSPACE).root;
test.use({ initialWorkingDir: ROOT_CONTAINER });

async function openToolbox(appPage: Page) {
  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  await expect(appPage.getByRole('heading', { name: '工具箱', exact: true })).toBeVisible();
  await expect(appPage.getByRole('tab', { name: '全部', exact: true })).toBeVisible();
}

async function sendProbe(appPage: Page) {
  const input = appPage.locator('[data-testid="chat-input"]:visible');
  await input.fill('电脑控制开关探测');
  await input.press('Enter');
}

test('Toolbox Computer switch controls new-conversation discovery and persists', async ({
  appPage,
}, testInfo) => {
  await openToolbox(appPage);
  const switchControl = appPage.getByRole('switch', { name: /关闭.*电脑控制/u });
  await expect(switchControl).toBeChecked();
  await switchControl.click();
  await expect(appPage.getByRole('switch', { name: /打开.*电脑控制/u })).not.toBeChecked();

  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await sendProbe(appPage);
  await expect(appPage.getByText('COMPUTER_NOT_AVAILABLE', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });
  const disabledScreenshot = testInfo.outputPath('computer-disabled-conversation.png');
  await appPage.screenshot({ path: disabledScreenshot, fullPage: true });

  await openToolbox(appPage);
  const disabledSwitch = appPage.getByRole('switch', { name: /打开.*电脑控制/u });
  await disabledSwitch.click();
  await expect(appPage.getByRole('switch', { name: /关闭.*电脑控制/u })).toBeChecked();

  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await sendProbe(appPage);
  await expect(appPage.getByText('COMPUTER_TOOL_CALLED', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });
  const enabledScreenshot = testInfo.outputPath('computer-enabled-conversation.png');
  await appPage.screenshot({ path: enabledScreenshot, fullPage: true });

  await appPage.reload({ waitUntil: 'domcontentloaded' });
  await openToolbox(appPage);
  await expect(appPage.getByRole('switch', { name: /关闭.*电脑控制/u })).toBeChecked();

  const evidencePath = testInfo.outputPath('computer-toggle-evidence.json');
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        disabledConversationResult: 'COMPUTER_NOT_AVAILABLE',
        enabledConversationResult: 'COMPUTER_TOOL_CALLED',
        enabledConversationExecuted: 'computer_observe',
        persistedAcrossReload: true,
        screenshots: {
          disabled: disabledScreenshot,
          enabled: enabledScreenshot,
        },
      },
      null,
      2
    ),
    'utf8'
  );
  await testInfo.attach('computer-toggle-evidence', {
    path: evidencePath,
    contentType: 'application/json',
  });
  await testInfo.attach('computer-disabled-conversation', {
    path: disabledScreenshot,
    contentType: 'image/png',
  });
  await testInfo.attach('computer-enabled-conversation', {
    path: enabledScreenshot,
    contentType: 'image/png',
  });
});
