import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.setTimeout(240_000);

test('Electron persists the compaction choice across windows without changing conversation defaults', async ({ appPage, isolatedProfileRoot }, testInfo) => {
  const requests: Array<{ model: string; stream?: boolean }> = [];
  const answer = 'CodePro 本地测试响应：已收到请求。';
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'codepro-e2e' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push(body);
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'acceptance', model: 'codepro-e2e',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: answer }, null], [{}, 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'acceptance', model: 'codepro-e2e',
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  try {
    const providerId = await appPage.evaluate(async baseUrl => {
      const entry = '/src/acp/acpConnection.ts';
      const { getAcpClient } = await import(entry);
      const client = await getAcpClient();
      const result = await client.goose.providersCustomCreate_unstable({
        engine: 'openai_compatible', displayName: 'Compaction acceptance', apiUrl: baseUrl,
        requiresAuth: false, models: ['codepro-e2e'], supportsStreaming: true, headers: {},
      });
      await client.goose.defaultsSave_unstable({ providerId: result.providerId, modelId: 'codepro-e2e' });
      return result.providerId as string;
    }, `http://127.0.0.1:${address.port}`);
    await appPage.evaluate(() => { location.hash = '/codepro/settings?section=models'; });
    await appPage.getByRole('button', { name: '上下文容量', exact: true }).click();
    const select = appPage.getByRole('combobox', { name: '压缩模型', exact: true });
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('');
    const choice = JSON.stringify([providerId, 'codepro-e2e']);
    await select.selectOption(choice);
    await appPage.getByRole('button', { name: '保存压缩模型', exact: true }).click();
    await expect(appPage.getByRole('status').filter({ hasText: '已保存，后续请求和手动压缩使用此设置。' })).toBeVisible();

    const created = appPage.context().waitForEvent('page');
    await appPage.evaluate(() => window.electron.createChatWindow({ workspaceMode: 'codepro' }));
    const other = await created;
    await expect(other.getByTestId('chat-input').filter({ visible: true })).toBeVisible();
    await other.evaluate(() => { location.hash = '/codepro/settings?section=models'; });
    await other.getByRole('button', { name: '上下文容量', exact: true }).click();
    const otherSelect = other.getByRole('combobox', { name: '压缩模型', exact: true });
    await expect(otherSelect).toHaveValue(choice);
    await appPage.screenshot({ path: testInfo.outputPath('compaction-choice.png') });
    await otherSelect.selectOption('');
    await other.getByRole('button', { name: '保存压缩模型', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: '已保存，后续请求和手动压缩使用此设置。' })).toBeVisible();
    await appPage.reload();
    await appPage.getByRole('button', { name: '上下文容量', exact: true }).click();
    await expect(select).toHaveValue('');
    const saved = await appPage.evaluate(async () => {
      const entry = '/src/acp/config.ts';
      const { acpReadConfig } = await import(entry);
      return acpReadConfig('compactionModel');
    });
    expect(saved).toBeNull();

    const workspace = join(isolatedProfileRoot, 'compaction-chat');
    mkdirSync(workspace);
    await appPage.evaluate(async dir => {
      await window.electron.addRecentDir(dir);
      location.hash = '/codepro';
    }, workspace);
    await appPage.getByRole('button', { name: '选择工作区' }).click();
    await appPage.getByRole('menuitem').filter({ hasText: 'compaction-chat' }).click();
    const input = appPage.getByTestId('chat-input').filter({ visible: true });
    await input.fill('回复本地测试确认');
    await input.press('Enter');
    await expect(appPage.getByTestId('message-container').getByText('CodePro 本地测试响应：已收到请求。', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(appPage.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    expect(requests.some(request => request.stream && request.model === 'codepro-e2e')).toBe(true);
    await appPage.screenshot({ path: testInfo.outputPath('conversation-after-settings.png') });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
