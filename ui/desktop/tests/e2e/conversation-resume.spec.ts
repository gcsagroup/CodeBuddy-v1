import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { createServer, type Server } from 'node:http';

test.setTimeout(180_000);
let server: Server;
let baseUrl: string;
const modelRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'codepro-e2e' }] })); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelRequests.push(body);
    const text = 'CodePro 本地测试响应：已收到请求。';
    const completion = { id: 'acceptance', model: 'codepro-e2e', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(completion)); return;
    }
    response.setHeader('content-type', 'text/event-stream');
    for (const choice of [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: 'acceptance', model: 'codepro-e2e', created: 1,
        object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test model did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve())); });
test('retry continues the current conversation without duplicating a user bubble, including reload', async ({ appPage, isolatedProfileRoot }, testInfo) => {
  const workspace = join(isolatedProfileRoot, 'resume-workspace');
  mkdirSync(workspace, { recursive: true });
  await expect(appPage.getByTestId('chat-input')).toBeVisible();
  // Seed only the isolated profile through the production ACP configuration API.
  await appPage.evaluate(async baseUrl => {
    const entry = '/src/acp/acpConnection.ts';
    const { getAcpClient } = await import(entry);
    const client = await getAcpClient();
    const result = await client.goose.providersCustomCreate_unstable({ engine: 'openai_compatible',
      displayName: 'Resume acceptance', apiUrl: baseUrl, requiresAuth: false,
      models: ['codepro-e2e'], supportsStreaming: true, headers: {} });
    await client.goose.defaultsSave_unstable({ providerId: result.providerId, modelId: 'codepro-e2e' });
  }, baseUrl);
  await appPage.reload();
  await expect(appPage.getByTestId('chat-input')).toBeVisible();
  await appPage.evaluate(dir => window.electron.addRecentDir(dir), workspace);
  await appPage.getByRole('button', { name: '选择工作区' }).click();
  await appPage.getByRole('menuitem').filter({ hasText: 'resume-workspace' }).click();
  const input = appPage.getByTestId('chat-input');
  await input.fill('回复本地测试确认');
  await input.press('Enter');
  const messages = appPage.getByTestId('message-container');
  const answers = messages.getByText(/^CodePro 本地(?:测试响应：已收到请求。|确定性模型已完成请求。)$/);
  await expect(answers).toHaveCount(1, { timeout: 90_000 });
  await expect(appPage.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  const originalUrl = appPage.url();
  await appPage.getByRole('button', { name: /重试|Retry/ }).last().click();
  await expect(answers).toHaveCount(2, { timeout: 60_000 });
  await expect(messages.getByText('回复本地测试确认', { exact: true })).toHaveCount(1);
  await expect(messages.getByText(/请从当前对话已有的进度继续完成任务/)).toHaveCount(0);
  await expect(appPage.getByRole('button', { name: '打开工作区面板' })).toBeVisible();
  expect(appPage.url()).toBe(originalUrl);
  await expect(appPage.locator('[data-chat-turn-id]')).toHaveCount(1);
  await expect(appPage.getByRole('button', { name: /重试|Retry/ })).toHaveCount(1);
  const continued = modelRequests.find(request => request.messages?.some(message =>
    message.role === 'user' && JSON.stringify(message.content).includes('请从当前对话已有的进度继续')));
  expect(continued).toBeDefined();
  expect(continued!.messages.filter(message => message.role === 'user' &&
    JSON.stringify(message.content).includes('回复本地测试确认'))).toHaveLength(1);
  expect(continued!.messages.some(message => message.role === 'assistant')).toBe(true);
  await appPage.reload();
  await expect(answers).toHaveCount(2, { timeout: 60_000 });
  await expect(messages.getByText('回复本地测试确认', { exact: true })).toHaveCount(1);
  await expect(messages.getByText(/请从当前对话已有的进度继续完成任务/)).toHaveCount(0);
  await expect(appPage.locator('[data-chat-turn-id]')).toHaveCount(1);
  await expect(appPage.getByRole('button', { name: /重试|Retry/ })).toHaveCount(1);
  // Retry again after replay: the remaining action must still target the
  // original visible request, not the hidden continuation instruction.
  await appPage.getByRole('button', { name: /重试|Retry/ }).click();
  await expect(answers).toHaveCount(3, { timeout: 60_000 });
  await expect(appPage.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  expect(appPage.url()).toBe(originalUrl);
  const resumedRequests = modelRequests.filter(request => request.messages?.some(message =>
    message.role === 'user' && JSON.stringify(message.content).includes('请从当前对话已有的进度继续')));
  const latestRequest = resumedRequests[resumedRequests.length - 1];
  expect(latestRequest.messages.filter(message => message.role === 'user' &&
    JSON.stringify(message.content).includes('回复本地测试确认'))).toHaveLength(1);
  expect(latestRequest.messages.filter(message => message.role === 'user' &&
    JSON.stringify(message.content).includes('请从当前对话已有的进度继续'))).toHaveLength(2);
  await appPage.reload();
  await expect(answers).toHaveCount(3, { timeout: 60_000 });
  await expect(messages.getByText('回复本地测试确认', { exact: true })).toHaveCount(1);
  await expect(messages.getByText(/请从当前对话已有的进度继续完成任务/)).toHaveCount(0);
  await expect(appPage.locator('[data-chat-turn-id]')).toHaveCount(1);
  await expect(appPage.getByRole('button', { name: /重试|Retry/ })).toHaveCount(1);
  await appPage.screenshot({ path: testInfo.outputPath('continued-conversation.png') });
});
