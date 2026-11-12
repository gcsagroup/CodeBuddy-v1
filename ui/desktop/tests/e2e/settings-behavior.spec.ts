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

test('memory controls, global rules and background task preferences', async ({ appPage }) => {
  await appPage.getByRole('button', { name: '设置', exact: true }).click();
  await appPage.getByTestId('settings-nav-memory').click();
  await expect(appPage.getByRole('switch')).toHaveCount(2);
  await expect(appPage.getByText('管理项目记忆', { exact: true })).toHaveCount(0);
  await expect(appPage.getByText('已保存的项目记忆', { exact: true })).toHaveCount(0);
  await appPage.getByTestId('settings-nav-chat').click();
  await appPage.getByRole('button', { name: 'CodeBuddy 规则', exact: true }).click();
  await expect(appPage.getByRole('textbox').last()).toBeVisible();
  await appPage.getByTestId('settings-nav-app').click();
  const notify = appPage.getByRole('switch', { name: '任务完成通知', exact: true });
  const awake = appPage.getByRole('switch', { name: '阻止休眠', exact: true });
  await expect(notify).toBeChecked();
  await expect(awake).not.toBeChecked();
  await notify.click();
  await awake.click();
  await expect.poll(() => appPage.evaluate(() => window.electron.getSetting('enableNotifications'))).toBe(false);
  await expect.poll(() => appPage.evaluate(() => window.electron.getWakelockState())).toBe(true);
  await appPage.getByTestId('settings-nav-memory').click();
  await appPage.getByTestId('settings-nav-app').click();
  await expect(notify).not.toBeChecked();
  await expect(awake).toBeChecked();
  await expect(appPage.getByRole('button', { name: '打开系统设置', exact: true })).toBeVisible();
});
