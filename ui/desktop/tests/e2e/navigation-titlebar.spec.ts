import { expect, test } from './fixtures';

test.setTimeout(180_000);

test('Windows titlebar keeps one sidebar toggle before File and restores navigation', async ({ appPage }, testInfo) => {
  const toggle = appPage.locator('#window-navigation-toggle button');
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toBeVisible();
  const file = appPage.getByRole('menuitem', { name: '文件', exact: true });
  const toggleBox = (await toggle.boundingBox())!;
  const fileBox = (await file.boundingBox())!;
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(fileBox.x);
  expect(Math.abs(toggleBox.y + toggleBox.height / 2 - fileBox.y - fileBox.height / 2)).toBeLessThan(2);
  await expect(appPage.getByRole('button', { name: /^(折叠导航|展开导航)$/ })).toHaveCount(1);

  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const sidebar = appPage.locator('aside').filter({ has: appPage.locator('.shell-navigation') });
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(0);
  await expect(toggle).toBeFocused();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(190);

  const composer = appPage.getByTestId('chat-input').filter({ visible: true });
  await composer.click();
  await expect(composer).toBeFocused();
  await appPage.keyboard.press('F10');
  await expect(file).toBeFocused();
  await appPage.keyboard.press('End');
  await expect(appPage.getByRole('menuitem', { name: '帮助', exact: true })).toBeFocused();
  await appPage.keyboard.press('Home');
  await expect(file).toBeFocused();
  await appPage.keyboard.press('Escape');
  await expect(composer).toBeFocused();
  await appPage.screenshot({ path: testInfo.outputPath('navigation-titlebar.png') });
});
