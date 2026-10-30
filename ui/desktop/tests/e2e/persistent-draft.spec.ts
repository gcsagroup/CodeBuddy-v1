import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base } from './fixtures';

// Each test launches a fresh Electron process, but shares this isolated profile
// to exercise a full process restart rather than only a renderer reload.
const test = base.extend({
  isolatedProfileRoot: async ({}, use, testInfo) => {
    const root = path.join(testInfo.project.outputDir, 'persistent-profile');
    mkdirSync(root, { recursive: true });
    await use(root);
  },
});
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
const prompt = '  重启恢复中文草稿 🙂\n附件一并保留  ';
const imageName = '草稿图片.png';
const documentName = '草稿文档 [1].txt';

test('Persistent draft 1: save text, image and document through the real composer', async ({
  appPage,
  isolatedProfileRoot,
}, info) => {
  const image = path.join(isolatedProfileRoot, imageName);
  const document = path.join(isolatedProfileRoot, documentName);
  writeFileSync(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=',
      'base64'
    )
  );
  writeFileSync(document, 'persistent document fixture');
  await appPage.getByTestId('chat-input').fill(prompt);
  await appPage.locator('input[type=file]').setInputFiles(image);
  await expect(appPage.getByRole('img', { name: imageName, exact: true })).toBeVisible();
  await appPage.locator('input[type=file]').setInputFiles(document);
  await expect(appPage.getByText(documentName, { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const draft = await appPage.evaluate(() => window.electron.newTaskDraft({ action: 'read' }));
      return draft.codepro?.files?.map((file) => ({
        name: file.name,
        ready: !file.isLoading && !file.error,
      }));
    })
    .toEqual([
      { name: imageName, ready: true },
      { name: documentName, ready: true },
    ]);
  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(appPage.getByTestId('chat-input')).toHaveValue(prompt);
  await expect(appPage.getByRole('img', { name: imageName, exact: true })).toBeVisible();
  await appPage.screenshot({ path: info.outputPath('before-restart.png') });
});

test('Persistent draft 2: restore after process restart without original attachment files', async ({
  appPage,
  isolatedProfileRoot,
}, info) => {
  rmSync(path.join(isolatedProfileRoot, imageName));
  rmSync(path.join(isolatedProfileRoot, documentName));
  // A reload revalidates saved copies after source removal as well.
  await appPage.reload();
  await expect(appPage.getByTestId('chat-input')).toHaveValue(prompt);
  await expect(appPage.getByRole('img', { name: imageName, exact: true })).toBeVisible();
  await expect(appPage.getByText(documentName, { exact: true })).toBeVisible();
  const restored = await appPage.evaluate(() => window.electron.newTaskDraft({ action: 'read' }));
  expect(restored.codepro?.files?.every((file) => !file.error)).toBe(true);
  await appPage.screenshot({ path: info.outputPath('after-restart.png') });
  await appPage.getByTestId('chat-input').press('Enter');
  await expect(appPage.locator('[data-session-id]:visible')).toBeVisible();
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(appPage.getByTestId('chat-input')).toHaveValue('');
  await expect(appPage.getByRole('img', { name: imageName, exact: true })).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await appPage.evaluate(() => window.electron.newTaskDraft({ action: 'read' }))).codepro
          ?.files?.length
    )
    .toBe(0);
});

test('Persistent draft 3: sent draft stays cleared after another process restart', async ({
  appPage,
}) => {
  await expect(appPage.getByTestId('chat-input')).toHaveValue('');
  await expect(appPage.getByText(documentName, { exact: true })).toHaveCount(0);
  await expect(appPage.getByRole('img', { name: imageName, exact: true })).toHaveCount(0);
});
