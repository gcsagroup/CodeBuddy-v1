import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test('first running conversation can be viewed as JSON before and after completion', async ({ appPage, isolatedProfileRoot }, info) => {
  test.setTimeout(180000);
  const prompt = 'Live export acceptance: report the synthetic receipt';
  let finish: (() => void) | undefined;
  const provider = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'export-acceptance' }] })); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Live export acceptance' }, finish_reason: 'stop' }] })); return;
    }
    response.setHeader('content-type', 'text/event-stream');
    const send = (delta: object, reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'export-test', model: 'export-acceptance', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    send({ role: 'assistant', content: 'Synthetic receipt received. ' });
    finish = () => {
      if (response.writableEnded || response.destroyed) return;
      send({ content: 'Export acceptance complete.' });
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
    };
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not listen');
  try {
    await expect(appPage.getByTestId('chat-input')).toBeVisible();
    await appPage.evaluate(async apiUrl => {
      const entry = '/src/acp/acpConnection.ts';
      const { getAcpClient } = await import(entry);
      const client = await getAcpClient();
      const provider = await client.goose.providersCustomCreate_unstable({ engine: 'openai_compatible', displayName: 'Export acceptance', apiUrl, requiresAuth: false, models: ['export-acceptance'], supportsStreaming: true, headers: {} });
      await client.goose.defaultsSave_unstable({ providerId: provider.providerId, modelId: 'export-acceptance' });
    }, `http://127.0.0.1:${address.port}`);
    await appPage.reload();
    const workspace = join(isolatedProfileRoot, 'export-workspace');
    mkdirSync(workspace, { recursive: true });
    await appPage.evaluate(dir => window.electron.addRecentDir(dir), workspace);
    await appPage.getByRole('button', { name: '选择工作区' }).click();
    await appPage.getByRole('menuitem').filter({ hasText: 'export-workspace' }).click();
    const input = appPage.getByTestId('chat-input');
    await input.fill(prompt);
    await input.press('Enter');
    await expect(appPage.getByTestId('message-container').getByText('Synthetic receipt received.', { exact: false })).toBeVisible({ timeout: 60000 });
    const viewJson = async () => {
      await appPage.locator('[data-session-row]').first().click({ button: 'right' });
      await appPage.getByRole('menuitem', { name: /JSON/ }).click();
      const dialog = appPage.getByRole('dialog');
      await expect(dialog).toContainText('conversation');
      const collapsed = dialog.locator('button').filter({ has: appPage.locator('svg.lucide-chevron-right') });
      for (let index = 0; index < 30 && await collapsed.count(); index++) await collapsed.first().click();
      await expect(dialog).toContainText(prompt);
      await expect(dialog).toContainText('Synthetic receipt received.');
      return dialog;
    };
    await viewJson();
    await appPage.screenshot({ path: info.outputPath('live-export.png') });
    await appPage.keyboard.press('Escape');
    expect(finish).toBeDefined();
    finish!();
    await expect(appPage.getByRole('button', { name: '发送', exact: true })).toBeVisible({ timeout: 60000 });
    await expect(await viewJson()).toContainText('Export acceptance complete.');
    await appPage.screenshot({ path: info.outputPath('completed-export.png') });
  } finally {
    finish?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
