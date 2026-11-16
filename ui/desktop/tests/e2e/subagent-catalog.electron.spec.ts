import { expect, test } from './fixtures';

test('opens the readonly subagent catalog for a session without a writable workspace', async ({
  appPage, isolatedProfileRoot,
}) => {
  test.setTimeout(180_000);
  const sessionId = await appPage.evaluate(async (cwd) => {
    const modulePath = '/src/sessions.ts';
    const { createSession } = await import(modulePath);
    const leaseModule = '/src/acp/workspaceLease.ts';
    const { acquireWorkspaceLease } = await import(leaseModule);
    const [workspace] = await window.electron.inspectCodeProWorkspace({ prompt: '', selectedWorkingDir: cwd });
    const lease = await acquireWorkspaceLease({
      requestedPath: workspace.requestedPath,
      expectedState: workspace.state,
      expectedIdentity: workspace.normalizedIdentity,
    });
    const session = await createSession(lease.workingDir, {
      workspaceLeaseId: lease.leaseId,
      workspaceBinding: 'unbound',
      workspaceMode: 'codepro',
    });
    return session.id as string;
  }, isolatedProfileRoot);
  await appPage.evaluate(id => { location.hash = '/codepro/pair?resumeSessionId=' + encodeURIComponent(id); }, sessionId);
  await appPage.getByRole('button', { name: '打开工作区面板' }).click();
  const panel = appPage.locator('aside').filter({ has: appPage.getByRole('tab', { name: '子智能体' }) });
  await expect(panel.getByRole('button', { name: /工作区文件/ })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /终端/ })).toBeDisabled();
  await panel.getByRole('tab', { name: '子智能体' }).click();
  await expect(panel.getByText('此目录中暂无子智能体。')).toBeVisible();
  await panel.getByRole('button', { name: '刷新子智能体' }).click();
  await expect(panel.getByText('此目录中暂无子智能体。')).toBeVisible();
});
