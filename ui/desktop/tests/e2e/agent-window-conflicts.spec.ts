import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.setTimeout(180_000);

async function openManager(page: Page, sessionId = '') {
  await page.evaluate(id => { location.hash = '/codepro/custom-agents' + (id ? '?sessionId=' + encodeURIComponent(id) : ''); }, sessionId);
  await expect(page.getByRole('button', { name: '新建智能体' })).toBeEnabled();
}

async function secondWindow(page: Page) {
  const newWindow = page.context().waitForEvent('page');
  await page.evaluate(() => window.electron.createChatWindow({ workspaceMode: 'codepro' }));
  const other = await newWindow;
  await expect(other.getByTestId('chat-input').filter({ visible: true })).toBeVisible();
  return other;
}

test('two Electron windows retry only the saved role and order usage by the original selection', async ({ appPage, isolatedProfileRoot }) => {
  const workspace = join(isolatedProfileRoot, 'agent-workspace');
  mkdirSync(workspace);
  const [sessionA, sessionB] = await appPage.evaluate(async cwd => {
    const path = '/src/codepro/startCodeProSession.ts';
    const { startCodeProSession } = await import(path);
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const [candidate] = await window.electron.inspectCodeProWorkspace({ prompt: '', selectedWorkingDir: cwd });
      const { session } = await startCodeProSession({
        candidate, workspaceOrigin: 'selected', allExtensions: [], initialMessage: { msg: '', images: [] },
      });
      ids.push(session.id as string);
    }
    return ids;
  }, workspace);
  const other = await secondWindow(appPage);
  await Promise.all([openManager(appPage, sessionA), openManager(other, sessionA)]);

  await appPage.getByRole('button', { name: '新建智能体' }).click();
  await appPage.getByLabel('名称', { exact: true }).fill('双窗口伙伴');
  await appPage.getByLabel('人设提示词').fill('Provide concise answers.');
  await other.getByRole('button', { name: '应用到当前对话 前端开发工程师' }).click();
  await expect(other).toHaveURL(/resumeSessionId=/);
  await appPage.getByRole('button', { name: '保存并应用' }).click();
  await expect(appPage.getByRole('alert')).toBeVisible();
  await expect(appPage.getByRole('status').filter({ hasText: '已保存，尚未应用' })).toContainText('前端开发工程师');
  await appPage.getByRole('button', { name: '重试应用' }).click();
  await expect(appPage).toHaveURL(/resumeSessionId=/);
  const saved = await appPage.evaluate(async sessionId => {
    const path = '/src/components/custom-agents/agentApi.ts';
    const { agentRequest } = await import(path);
    const { selection } = await agentRequest('current', { sessionId });
    const { profiles } = await agentRequest('list');
    return { selection, profiles };
  }, sessionA);
  expect(saved.profiles).toHaveLength(1);
  expect(saved.selection.profile).toMatchObject({ name: '双窗口伙伴', revision: 1 });
  expect(saved.profiles[0].revision).toBe(1);
  expect(saved.selection.revision).toBe(2);

  await Promise.all([openManager(appPage, sessionA), openManager(other, sessionB)]);
  // Delay only delivery of A's successful host receipt. B uses a different
  // native window, the same disk-backed profile, and an unmodified ACP client.
  await appPage.evaluate(async () => {
    const path = '/src/acp/acpConnection.ts';
    const { getAcpControlClient } = await import(path);
    const client = await getAcpControlClient();
    const original = client.extMethod.bind(client);
    client.extMethod = async (method: string, input: Record<string, unknown>) => {
      const reply = await original(method, input);
      if (method === '_codebuddy/agents/select') {
        client.extMethod = original;
        await new Promise<void>(resolve => {
          window.addEventListener('test-release-role-receipt', () => resolve(), { once: true });
          document.documentElement.dataset.roleReceipt = 'waiting';
        });
      }
      return reply;
    };
  });
  await appPage.getByRole('button', { name: '应用到当前对话 双窗口伙伴' }).click();
  await expect(appPage.locator('html')).toHaveAttribute('data-role-receipt', 'waiting');
  await other.getByRole('button', { name: '应用到当前对话 前端开发工程师' }).click();
  await expect(other).toHaveURL(/resumeSessionId=/);
  await appPage.evaluate(() => window.dispatchEvent(new Event('test-release-role-receipt')));
  await expect(appPage).toHaveURL(/resumeSessionId=/);
  await expect(other.getByTestId('chat-input').filter({ visible: true })).toBeVisible();
  const otherRole = await other.evaluate(async sessionId => {
    const path = '/src/components/custom-agents/agentApi.ts';
    const { agentRequest } = await import(path);
    return (await agentRequest('current', { sessionId })).selection.profile;
  }, sessionB);
  expect(otherRole.name).toBe('前端开发工程师');
  for (const page of [appPage, other]) {
    await expect.poll(() => page.evaluate(async () => {
      const path = '/src/utils/recentAgents.ts';
      return (await import(path)).getRecentAgents();
    })).toEqual([otherRole.id, saved.profiles[0].id]);
  }
});

test.describe('existing duplicate names', () => {
  test.beforeEach(async ({ isolatedProfileRoot }) => {
    // Seed the historical state before Electron starts and acquires the profile lock.
    if (!isolatedProfileRoot) throw new Error('This fixture requires an isolated profile');
    const { openStore } = await import('../../../../runtime/store.mjs');
    const store = await openStore(join(isolatedProfileRoot, '.CodeBuddy', 'backend'), {
      defaultModel: {
        providerId: 'custom_local_fixture', modelId: 'isolated-role-test',
        baseUrl: 'http://127.0.0.1:1', contextWindow: 8192,
      },
    });
    await store.update((state: { agentProfiles: unknown[] }) => {
      state.agentProfiles = ['旧版甲', '旧版乙'].map(prompt => ({
        id: randomUUID(), revision: 1, name: '同名伙伴', avatar: '📚', prompt,
        skills: [], tools: [], mcpServers: [], capabilities: 'inherit',
      }));
    }, ['agentProfiles']);
  });

  test('two Electron windows edit distinct legacy namesakes and reject a new namesake', async ({ appPage }) => {
    const other = await secondWindow(appPage);
    const edits = [[appPage, '旧版甲'], [other, '旧版乙']] as const;
    await Promise.all(edits.map(async ([page, prompt]) => {
      await openManager(page);
      await page.getByRole('article').filter({ hasText: prompt }).getByRole('button', { name: '编辑' }).click();
      await page.getByLabel('人设提示词').fill(prompt + '已更新');
    }));
    await Promise.all(edits.map(([page]) => page.getByRole('button', { name: '仅保存' }).click()));
    for (const [page, prompt] of edits) {
      await expect(page.getByRole('article').filter({ hasText: prompt + '已更新' })).toBeVisible();
    }
    await appPage.getByRole('button', { name: '新建智能体' }).click();
    await appPage.getByLabel('名称', { exact: true }).fill('同名伙伴');
    await appPage.getByLabel('人设提示词').fill('第三个');
    await appPage.getByRole('button', { name: '仅保存' }).click();
    await expect(appPage.getByRole('alert')).toContainText('已存在');
    await other.reload();
    for (const [, prompt] of edits) {
      await expect(other.getByRole('article').filter({ hasText: prompt + '已更新' })).toBeVisible();
    }
    await expect(other.getByRole('heading', { name: '同名伙伴', exact: true })).toHaveCount(2);
  });
});
