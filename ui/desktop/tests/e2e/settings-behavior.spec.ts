import { expect, test } from './fixtures';

test.setTimeout(480_000);

test('removes the raw configuration editor and persists response style', async ({ appPage }) => {
  await appPage.getByRole('button', { name: '设置', exact: true }).click();
  await expect(appPage.getByRole('heading', { name: '设置', exact: true })).toBeVisible();

  await appPage.getByTestId('settings-nav-app').click();
  await expect(appPage.getByText('配置编辑器', { exact: true })).toHaveCount(0);
  await expect(appPage.getByText('编辑配置', { exact: true })).toHaveCount(0);

  await appPage.getByTestId('settings-nav-chat').click();
  await appPage.getByText('详细', { exact: true }).click();
  await expect
    .poll(() => appPage.evaluate(() => window.electron.getSetting('responseStyle')))
    .toBe('detailed');

  await appPage.reload({ waitUntil: 'domcontentloaded' });
  await appPage.getByRole('button', { name: '设置', exact: true }).click();
  await appPage.getByTestId('settings-nav-chat').click();
  await expect(appPage.getByRole('radio', { name: '详细' })).toBeChecked();
});
