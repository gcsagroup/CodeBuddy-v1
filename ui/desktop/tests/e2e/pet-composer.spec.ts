import { expect, test } from './fixtures';

test.setTimeout(180_000);

test('pet add menu transfers a draft across real Electron windows without sending', async ({ appPage }, testInfo) => {
  await expect(appPage.getByTestId('chat-input')).toBeVisible();
  // Configure only the fixture profile; subsequent interactions use the real UI.
  await appPage.evaluate(async () => {
    const snapshot = await window.electron.desktopPet({ action: 'get' });
    const pet = snapshot.pets.find(item => item.builtin) ?? snapshot.pets[0];
    if (!pet) throw new Error('No bundled pet available');
    await window.electron.desktopPet({ action: 'configure', preferences: { visible: true, selectedId: pet.id } });
  });
  const browser = appPage.context().browser()!;
  let petPage: import('@playwright/test').Page | undefined;
  await expect.poll(() => {
    petPage = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('pet'));
    return Boolean(petPage);
  }).toBe(true);
  const pet = petPage!;
  await pet.getByRole('button', { name: /Message your pet|点击宠物发消息/ }).click();
  const editor = pet.getByRole('textbox');
  await expect(editor).toBeVisible();
  await editor.fill('pet handoff acceptance draft');
  await pet.getByRole('button', { name: /添加附件或功能|Add attachments or features/ }).click();
  await expect(pet.getByRole('button', { name: /^(文件|File)$/ })).toBeVisible();
  await pet.getByRole('button', { name: /在主对话选择技能和工具|Skills and tools in main conversation/ }).click();
  await expect(appPage.getByTestId('chat-input')).toHaveValue('pet handoff acceptance draft');
  await expect(appPage.locator('[data-composer-menu="add"]')).toBeVisible();
  await expect(editor).not.toBeVisible();
  await expect(appPage.getByTestId('chat-input')).toBeEditable();
  await appPage.screenshot({ path: testInfo.outputPath('pet-draft-handoff.png') });
});

