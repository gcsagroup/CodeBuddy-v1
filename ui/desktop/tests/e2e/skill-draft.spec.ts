import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.setTimeout(180_000);

test('Skill draft opens new chat without allocating folders and creates only after Send', async ({
  appPage,
  isolatedProfileRoot,
}, testInfo) => {
  const workspaceRoot = join(isolatedProfileRoot, '.CodeBuddy', 'workspaces');
  const folders = () => (existsSync(workspaceRoot) ? readdirSync(workspaceRoot).sort() : []);
  const before = folders();
  for (let attempt = 0; attempt < 2; attempt++) {
    await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
    await appPage.getByRole('tab', { name: '技能', exact: true }).click();
    await appPage.getByText('comfyui', { exact: true }).click();
    const detail = appPage.getByRole('dialog', { name: 'comfyui' });
    await detail.getByRole('button', { name: '使用技能', exact: true }).click();
    await expect(appPage.locator('[data-testid="chat-input"]:visible')).toHaveValue(
      '使用 comfyui 技能：'
    );
    await expect(appPage.locator('#codepro-title')).toBeVisible();
    expect(new URL(appPage.url()).hash).not.toContain('resumeSessionId');
    expect(folders()).toEqual(before);
  }
  const input = appPage.locator('[data-testid="chat-input"]:visible');
  const toolboxDraft = await input.inputValue();
  await input.fill('/');
  await appPage.getByText('comfyui', { exact: true }).click();
  await expect(input).toHaveValue(toolboxDraft);
  expect(folders()).toEqual(before);
  await appPage.screenshot({ path: testInfo.outputPath('skill-new-chat-draft.png') });
  await input.fill(`${toolboxDraft}请介绍这个技能，不生成任何图片或视频。`);
  expect(folders()).toEqual(before);
  await input.press('Enter');
  await expect.poll(() => new URL(appPage.url()).hash).toContain('resumeSessionId');
  await expect.poll(() => folders().length).toBe(before.length + 1);
  await appPage.screenshot({ path: testInfo.outputPath('skill-user-created-chat.png') });
});
