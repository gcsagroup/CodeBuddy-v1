import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test('Question attention links the sidebar and pet to the right chat with independent panel state', async ({
  appPage: page, isolatedProfileRoot,
}) => {
  test.setTimeout(360_000);
  const workspace = join(isolatedProfileRoot, 'question-workspace');
  mkdirSync(workspace);
  await page.evaluate(dir => window.electron.addRecentDir(dir), workspace);
  await page.reload();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(选择工作区|请选择目录)$/ }).click();
  await page.getByRole('menuitem').filter({ hasText: 'question-workspace' }).click();
  await expect(page.getByRole('button', {name:/codepro-e2e/i}).first()).toBeVisible();
  const petReady = page.context().waitForEvent('page');
  await page.evaluate(() => window.electron.desktopPet({ action: 'configure', preferences: {
    selectedId: 'red-panda', visible: true,
  } }));
  const pet = await petReady;
  await page.bringToFront();
  const prompt = page.getByTestId('chat-input');
  await prompt.fill('QUESTION_ATTENTION_E2E 请提问并等待我的答复。');
  await prompt.press('Enter');
  const pending = page.locator('[data-session-row]').filter({hasText: '待回复'});
  const notice = page.getByRole('button', { name: /去回复 Agent/ });
  await expect(notice).toBeVisible({ timeout: 90000 });
  await expect(pending).toHaveCount(1);
  const petCard = pet.locator('.pet-task-card').filter({hasText: '验收时选择哪种颜色？'});
  await expect(petCard.getByRole('button', { name: '去回复', exact: true })).toBeVisible();
  const panelOpen = page.getByRole('button', { name: '打开工作区面板' });
  const panelClose = page.getByTitle('收起面板', {exact:true});
  await panelOpen.click();
  const first = page.url();
  await page.getByRole('button', { name: '主对话', exact: true }).click();
  await expect(page).not.toHaveURL(first);
  await expect(panelOpen).toBeVisible();
  await notice.click();
  await expect(page).toHaveURL(first);
  await expect(panelClose).toBeVisible();
  await page.getByRole('button', { name: '主对话', exact: true }).click();
  await expect(page).not.toHaveURL(first);
  await panelOpen.click();
  await panelClose.click();
  await petCard.getByRole('button', { name: '去回复', exact: true }).click();
  await expect(page).toHaveURL(first);
  await expect(panelClose).toBeVisible();
  await panelClose.click();
  const question = page.getByRole('region', {name:/问题|回复或确认/});
  await question.getByRole('textbox').fill('蓝色');
  await question.getByRole('button', {name:'发送'}).click();
  await expect(pending).toHaveCount(0);
  await expect(petCard).toHaveCount(0);
});
