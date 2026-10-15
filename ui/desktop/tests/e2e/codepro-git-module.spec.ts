import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expect, test } from './fixtures';

const temporaryRoot = resolve(tmpdir());
const workspace = resolve(mkdtempSync(join(temporaryRoot, 'codepro-git-module-e2e-')));
const workspaceRelativeToTemporaryRoot = relative(temporaryRoot, workspace);
if (
  !isAbsolute(workspace) ||
  !workspaceRelativeToTemporaryRoot ||
  workspaceRelativeToTemporaryRoot === '..' ||
  workspaceRelativeToTemporaryRoot.startsWith(`..${sep}`) ||
  isAbsolute(workspaceRelativeToTemporaryRoot)
) {
  throw new Error('Git module E2E workspace must be a unique child of the temporary directory');
}
let workspaceExists = true;
let gitDiagnosticEvents: Array<Record<string, unknown>> = [];

type GitAcpWebSocketDiagnostic = {
  at: string;
  direction: 'received' | 'sent';
  id?: string | number;
  method?: string;
  tool?: string;
  hasError?: boolean;
  hasResult?: boolean;
};

function sanitizeDiagnosticText(value: string): string {
  return value
    .replaceAll(workspace, '<workspace>')
    .replaceAll(resolve(process.cwd(), '..', '..'), '<source-root>')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, '$1<redacted>')
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)[^\s,;}]+/giu,
      '$1<redacted>'
    )
    .slice(0, 4_000);
}

function recordGitDiagnostic(event: string, details: Record<string, unknown> = {}): void {
  gitDiagnosticEvents.push({ at: new Date().toISOString(), event, ...details });
}

function cleanupWorkspace(): void {
  if (!workspaceExists) return;
  rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  workspaceExists = false;
}

process.once('exit', cleanupWorkspace);

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

function gitRefExists(ref: string): boolean {
  try {
    git('rev-parse', '--verify', ref);
    return true;
  } catch {
    return false;
  }
}

function gitForEvidence(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function gitOperationInProgress(operation: 'cherryPick' | 'merge' | 'rebase' | 'revert'): boolean {
  const gitDirectory = gitForEvidence('rev-parse', '--absolute-git-dir');
  if (!gitDirectory) return false;
  switch (operation) {
    case 'rebase':
      return (
        existsSync(join(gitDirectory, 'rebase-merge')) ||
        existsSync(join(gitDirectory, 'rebase-apply'))
      );
    case 'merge':
      return existsSync(join(gitDirectory, 'MERGE_HEAD'));
    case 'cherryPick':
      return existsSync(join(gitDirectory, 'CHERRY_PICK_HEAD'));
    case 'revert':
      return existsSync(join(gitDirectory, 'REVERT_HEAD'));
  }
}

function githubCliAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.use({ initialWorkingDir: workspace });
test.setTimeout(480_000);

test.beforeAll(() => {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  git('init', '-b', 'main');
  git('config', 'user.email', 'codepro-e2e@example.invalid');
  git('config', 'user.name', 'CodePro E2E');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "base";\n', 'utf8');
  git('add', '.');
  git('commit', '-m', 'base');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "staged";\n', 'utf8');
  git('add', 'src/staged.ts');
  git('switch', '--detach');
});

test.afterAll(cleanupWorkspace);

test.afterEach(async ({ appPage }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !existsSync(workspace)) return;
  const trackedFile = join(workspace, 'src', 'staged.ts');
  const repositoryStatePath = testInfo.outputPath('git-repository-state.json');
  writeFileSync(
    repositoryStatePath,
    JSON.stringify(
      {
        head: gitForEvidence('rev-parse', 'HEAD'),
        branch: gitForEvidence('branch', '--show-current'),
        status: gitForEvidence('status', '--porcelain=v2', '--untracked-files=all'),
        operations: {
          merge: gitOperationInProgress('merge'),
          rebase: gitOperationInProgress('rebase'),
          cherryPick: gitOperationInProgress('cherryPick'),
          revert: gitOperationInProgress('revert'),
        },
        trackedFile: existsSync(trackedFile) ? readFileSync(trackedFile, 'utf8') : null,
        untrackedFileExists: existsSync(join(workspace, 'keep-untracked.txt')),
      },
      null,
      2
    ),
    'utf8'
  );
  await testInfo.attach('git-repository-state', {
    path: repositoryStatePath,
    contentType: 'application/json',
  });
  recordGitDiagnostic('failure-ui-state', {
    permissionVisible: await appPage
      .getByRole('button', { name: '仅此次允许' })
      .isVisible()
      .catch(() => false),
    previewDialogVisible: await appPage
      .getByRole('complementary', { name: 'CodePro 任务' })
      .getByRole('dialog')
      .isVisible()
      .catch(() => false),
    pageUrl: appPage.url(),
  });
  const webSocketEvents = await appPage
    .evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __codeProGitAcpDiagnostics?: GitAcpWebSocketDiagnostic[];
            __codeProGitAcpRequestIds?: Array<string | number>;
            __codeProGitAcpPendingIds?: Array<string | number>;
            __codeProGitPermissionIds?: Array<string | number>;
          }
        ).__codeProGitAcpDiagnostics ?? []
    )
    .catch(() => []);
  gitDiagnosticEvents.push(...webSocketEvents);
  const diagnosticsPath = testInfo.outputPath('git-acp-ui-diagnostics.json');
  writeFileSync(diagnosticsPath, JSON.stringify(gitDiagnosticEvents, null, 2), 'utf8');
  await testInfo.attach('git-acp-ui-diagnostics', {
    path: diagnosticsPath,
    contentType: 'application/json',
  });
});

test('recovers detached HEAD and completes safe restore, branch, merge, cherry-pick, rebase, and revert workflows through the visible UI', async ({
  appPage,
}, testInfo) => {
  gitDiagnosticEvents = [];
  await appPage.evaluate(() => {
    const diagnosticWindow = globalThis as typeof globalThis & {
      __codeProGitAcpDiagnostics?: GitAcpWebSocketDiagnostic[];
      __codeProGitAcpRequestIds?: Array<string | number>;
      __codeProGitAcpPendingIds?: Array<string | number>;
      __codeProGitPermissionIds?: Array<string | number>;
      __codeProGitAcpInstrumented?: boolean;
    };
    if (diagnosticWindow.__codeProGitAcpInstrumented) return;
    diagnosticWindow.__codeProGitAcpInstrumented = true;
    diagnosticWindow.__codeProGitAcpDiagnostics = [];
    diagnosticWindow.__codeProGitAcpRequestIds = [];
    diagnosticWindow.__codeProGitAcpPendingIds = [];
    diagnosticWindow.__codeProGitPermissionIds = [];
    const summarizeMessage = (
      direction: GitAcpWebSocketDiagnostic['direction'],
      data: unknown
    ): void => {
      if (typeof data !== 'string') return;
      try {
        const message = JSON.parse(data) as Record<string, unknown>;
        const params =
          message.params && typeof message.params === 'object'
            ? (message.params as Record<string, unknown>)
            : undefined;
        const tool = typeof params?.name === 'string' ? params.name : undefined;
        const method = typeof message.method === 'string' ? message.method : undefined;
        const id =
          typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
        if (direction === 'sent' && tool?.startsWith('git_') && id !== undefined) {
          diagnosticWindow.__codeProGitAcpRequestIds?.push(id);
          diagnosticWindow.__codeProGitAcpPendingIds?.push(id);
        }
        if (
          direction === 'received' &&
          method?.toLowerCase().includes('permission') &&
          id !== undefined
        ) {
          diagnosticWindow.__codeProGitPermissionIds?.push(id);
        }
        const trackedResponse =
          id !== undefined &&
          (direction === 'received'
            ? diagnosticWindow.__codeProGitAcpRequestIds?.includes(id)
            : diagnosticWindow.__codeProGitPermissionIds?.includes(id));
        if (direction === 'received' && trackedResponse && id !== undefined) {
          diagnosticWindow.__codeProGitAcpPendingIds =
            diagnosticWindow.__codeProGitAcpPendingIds?.filter((pendingId) => pendingId !== id) ??
            [];
        }
        if (
          !tool?.startsWith('git_') &&
          !method?.toLowerCase().includes('permission') &&
          !trackedResponse
        ) {
          return;
        }
        diagnosticWindow.__codeProGitAcpDiagnostics?.push({
          at: new Date().toISOString(),
          direction,
          id,
          method,
          tool,
          hasError: message.error !== undefined,
          hasResult: message.result !== undefined,
        });
      } catch {
        return;
      }
    };
    const originalSend = globalThis.WebSocket.prototype.send;
    globalThis.WebSocket.prototype.send = function (
      data: Parameters<typeof globalThis.WebSocket.prototype.send>[0]
    ): void {
      summarizeMessage('sent', data);
      const observedSocket = this as InstanceType<typeof globalThis.WebSocket> & {
        __codeProGitObserved?: boolean;
      };
      if (!observedSocket.__codeProGitObserved) {
        observedSocket.__codeProGitObserved = true;
        observedSocket.addEventListener('message', (event) =>
          summarizeMessage('received', event.data)
        );
      }
      originalSend.call(this, data);
    };
  });
  const trackedRequests = new Map<object, string>();
  let trackedRequestSequence = 0;
  appPage.on('console', (message) => {
    const text = message.text();
    if (!/(?:git|permission|acp)/iu.test(text)) return;
    recordGitDiagnostic('renderer-console', {
      level: message.type(),
      text: sanitizeDiagnosticText(text),
    });
  });
  appPage.on('pageerror', (error) => {
    recordGitDiagnostic('renderer-pageerror', {
      message: sanitizeDiagnosticText(error.message),
    });
  });
  appPage.on('request', (request) => {
    const postData = request.postData() ?? '';
    if (!postData.includes('git_conflict_abort')) return;
    trackedRequestSequence += 1;
    const localRequestId = `git-request-${trackedRequestSequence}`;
    trackedRequests.set(request, localRequestId);
    const protocolIds = [
      ...postData.matchAll(/"(?:requestId|request_id|id)"\s*:\s*"([^"\\]+)"/gu),
    ].map((match) => match[1]);
    recordGitDiagnostic('acp-request-sent', {
      localRequestId,
      method: request.method(),
      path: new URL(request.url()).pathname,
      protocolIds,
      tool: postData.includes('git_conflict_abort_preview')
        ? 'git_conflict_abort_preview'
        : 'git_conflict_abort',
    });
  });
  appPage.on('response', (response) => {
    const localRequestId = trackedRequests.get(response.request());
    if (!localRequestId) return;
    recordGitDiagnostic('acp-response-received', {
      localRequestId,
      status: response.status(),
      path: new URL(response.url()).pathname,
    });
  });
  const codeProHome = appPage.getByRole('heading', { name: '欢迎使用 CodePro' });
  const codeProSwitch = appPage.getByRole('button', { name: 'CodePro', exact: true });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await codeProHome.isVisible().catch(() => false)) break;
    if (await codeProSwitch.isVisible().catch(() => false)) {
      await codeProSwitch.click().catch(() => {});
    }
    await appPage.waitForTimeout(250);
  }
  await expect(codeProHome).toBeVisible();
  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  await appPage.getByRole('button', { name: '请选择目录' }).click();
  await appPage.getByRole('menuitem').filter({ hasText: 'codepro-git-module-e2e' }).click();
  const input = appPage.getByTestId('chat-input');
  await input.fill('回复本地测试确认');
  await appPage.getByRole('button', { name: '发送' }).click();
  const workspaceConfirmation = appPage.getByRole('heading', {
    name: '选择这个对话所属的项目',
  });
  await expect(workspaceConfirmation).toBeVisible();
  await appPage.getByRole('button', { name: '使用这个文件夹', exact: true }).click();
  await expect(workspaceConfirmation).not.toBeVisible();
  await expect(appPage.getByText(/CodePro 本地测试响应：已收到请求。/u).last()).toBeVisible({
    timeout: 120_000,
  });
  await expect(appPage.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 120_000 });

  await appPage.getByRole('button', { name: '打开 CodePro 任务面板' }).click();
  const panel = appPage.getByRole('complementary', { name: 'CodePro 任务' });
  await panel.getByRole('button', { name: '版本控制', exact: true }).click();
  const repositoryRefreshButton = panel.getByRole('button', { name: '刷新仓库' });
  const waitForGitAcpIdle = async () => {
    await expect
      .poll(
        () =>
          appPage.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __codeProGitAcpPendingIds?: Array<string | number>;
                }
              ).__codeProGitAcpPendingIds?.length ?? 0
          ),
        { timeout: 120_000 }
      )
      .toBe(0);
  };
  const waitForRepositoryIdle = async () => {
    await expect(repositoryRefreshButton).toBeEnabled({ timeout: 120_000 });
    await waitForGitAcpIdle();
  };
  const refreshRepository = async () => {
    await waitForRepositoryIdle();
    await repositoryRefreshButton.click();
    await waitForRepositoryIdle();
  };
  const approveOnceAndReturnToVersionControl = async () => {
    const allowOnce = appPage.getByRole('button', { name: '仅此次允许' });
    await expect(allowOnce).toBeVisible();
    await appPage.getByRole('button', { name: '关闭 CodePro 任务面板' }).click();
    await allowOnce.click();
    await appPage.getByRole('button', { name: '打开 CodePro 任务面板' }).click();
    await panel.getByRole('button', { name: '版本控制', exact: true }).click();
    await waitForRepositoryIdle();
  };
  const approveOnceIfRequestedAndReturnToVersionControl = async () => {
    const allowOnce = appPage.getByRole('button', { name: '仅此次允许' });
    await expect
      .poll(async () => {
        if (await allowOnce.isVisible()) {
          recordGitDiagnostic('permission-visible');
          return 'permission';
        }
        if (await panel.getByRole('dialog').isVisible()) {
          recordGitDiagnostic('preview-dialog-visible');
          return 'preview';
        }
        return 'waiting';
      })
      .not.toBe('waiting');
    if (!(await allowOnce.isVisible())) return;
    await appPage.getByRole('button', { name: '关闭 CodePro 任务面板' }).click();
    await allowOnce.click();
    await appPage.getByRole('button', { name: '打开 CodePro 任务面板' }).click();
    await panel.getByRole('button', { name: '版本控制', exact: true }).click();
    await waitForRepositoryIdle();
    recordGitDiagnostic('permission-approved');
  };
  const previewConflictAbort = async () => {
    recordGitDiagnostic('preview-click-start');
    await panel.getByRole('button', { name: '预览中止' }).click();
    recordGitDiagnostic('preview-click-complete');
  };
  await expect(panel.getByRole('heading', { name: '仓库', exact: true })).toBeVisible();
  if (!githubCliAvailable()) {
    await expect(
      panel.getByText(
        '尚未安装 GitHub CLI。Git 拉取和推送仍可正常使用；PR 和 Issue 操作需要 GitHub CLI。'
      )
    ).toBeVisible();
    await panel.getByRole('button', { name: '安装 GitHub CLI' }).click();
    const installDialog = appPage.getByRole('dialog');
    await expect(
      installDialog.getByText('是否在浏览器中打开 GitHub CLI 官方下载页面？')
    ).toBeVisible();
    await installDialog.getByRole('button', { name: '取消' }).click();
    await expect(installDialog).not.toBeVisible();
  }
  await expect(panel.getByRole('alert')).toContainText('请先创建或切换到分支');

  await panel.getByRole('button', { name: '取消暂存 src/staged.ts' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect
    .poll(async () => {
      const staged = git('diff', '--cached', '--name-only');
      return staged
        ? JSON.stringify({ staged, alerts: await panel.getByRole('alert').allTextContents() })
        : '';
    })
    .toBe('');
  expect(git('diff', '--name-only')).toBe('src/staged.ts');

  await panel.getByRole('checkbox', { name: '选择 src/staged.ts' }).check();
  await panel.getByRole('button', { name: '预览还原（1）' }).click();
  const restoreDialog = panel.getByRole('dialog');
  await expect(restoreDialog.getByText('还原 1 个所选路径？')).toBeVisible();
  await expect(restoreDialog.getByText('src/staged.ts', { exact: true })).toBeVisible();
  await restoreDialog.getByRole('button', { name: '确认还原' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => git('diff', '--name-only')).toBe('');
  expect(readFileSync(join(workspace, 'src', 'staged.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe(
    'export const value = "base";\n'
  );

  await panel.getByLabel('新分支名称').fill('recovery/fast');
  await panel.getByRole('button', { name: '创建分支' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => git('branch', '--show-current')).toBe('recovery/fast');

  await panel.getByLabel('本地分支').selectOption('main');
  await panel.getByRole('button', { name: '切换分支' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => git('branch', '--show-current')).toBe('main');
  expect(git('diff', '--name-only')).toBe('');

  git('switch', '-c', 'conflict/source');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "source";\n', 'utf8');
  git('add', 'src/staged.ts');
  git('commit', '-m', 'source conflict');
  git('switch', 'main');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "main";\n', 'utf8');
  git('add', 'src/staged.ts');
  git('commit', '-m', 'main conflict');
  const preMergeHead = git('rev-parse', 'HEAD');
  expect(() => git('merge', 'conflict/source')).toThrow();
  writeFileSync(join(workspace, 'keep-untracked.txt'), 'keep\n', 'utf8');

  await refreshRepository();
  await expect(panel.getByText('合并 进行中 · 1 个未解决冲突')).toBeVisible();
  await expect(panel.getByText('src/staged.ts · UU')).toBeVisible();
  await expect(panel.getByRole('button', { name: '继续合并' })).toBeDisabled();
  await previewConflictAbort();
  await approveOnceIfRequestedAndReturnToVersionControl();
  const abortDialog = panel.getByRole('dialog');
  await expect(abortDialog.getByText('中止合并并恢复到操作前状态？')).toBeVisible();
  await expect(abortDialog.getByText('src/staged.ts', { exact: true })).toBeVisible();
  await abortDialog.getByRole('button', { name: '确认中止' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitRefExists('MERGE_HEAD')).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(preMergeHead);
  expect(existsSync(join(workspace, 'keep-untracked.txt'))).toBe(true);

  expect(() => git('merge', 'conflict/source')).toThrow();
  await refreshRepository();
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "resolved";\n', 'utf8');
  await refreshRepository();
  await panel.getByRole('checkbox', { name: '选择 src/staged.ts' }).check();
  await panel.getByRole('button', { name: '暂存所选项（1）' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect(panel.getByText('合并 进行中 · 0 个未解决冲突')).toBeVisible();
  const conflictedHead = git('rev-parse', 'HEAD');
  await panel.getByRole('button', { name: '继续合并' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitRefExists('MERGE_HEAD')).toBe(false);
  expect(git('rev-parse', 'HEAD')).not.toBe(conflictedHead);
  expect(git('show', '-s', '--format=%s', 'HEAD')).toContain("Merge branch 'conflict/source'");

  git('switch', '-c', 'pick/source');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "picked";\n', 'utf8');
  git('add', 'src/staged.ts');
  git('commit', '-m', 'pick source');
  const pickedCommit = git('rev-parse', 'HEAD');
  git('switch', 'main');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const value = "pick-main";\n', 'utf8');
  git('add', 'src/staged.ts');
  git('commit', '-m', 'pick main');
  const prePickHead = git('rev-parse', 'HEAD');
  expect(() => git('cherry-pick', pickedCommit)).toThrow();

  await refreshRepository();
  await expect(panel.getByText('Cherry-pick 进行中 · 1 个未解决冲突')).toBeVisible();
  await expect(panel.getByRole('button', { name: '继续cherry-pick' })).toBeDisabled();
  await previewConflictAbort();
  await approveOnceIfRequestedAndReturnToVersionControl();
  await expect(
    panel.getByRole('dialog').getByText('中止cherry-pick并恢复到操作前状态？')
  ).toBeVisible();
  await panel.getByRole('dialog').getByRole('button', { name: '确认中止' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitRefExists('CHERRY_PICK_HEAD')).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(prePickHead);
  expect(existsSync(join(workspace, 'keep-untracked.txt'))).toBe(true);

  expect(() => git('cherry-pick', pickedCommit)).toThrow();
  await refreshRepository();
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "pick-resolved";\n',
    'utf8'
  );
  await refreshRepository();
  await panel.getByRole('checkbox', { name: '选择 src/staged.ts' }).check();
  await panel.getByRole('button', { name: '暂存所选项（1）' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect(panel.getByText('Cherry-pick 进行中 · 0 个未解决冲突')).toBeVisible();
  await panel.getByRole('button', { name: '继续cherry-pick' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitRefExists('CHERRY_PICK_HEAD')).toBe(false);
  expect(git('rev-parse', 'HEAD')).not.toBe(prePickHead);
  expect(git('show', '-s', '--format=%s', 'HEAD')).toBe('pick source');

  git('switch', '-c', 'rebase/source');
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "rebase-source";\n',
    'utf8'
  );
  git('add', 'src/staged.ts');
  git('commit', '-m', 'rebase source');
  const preRebaseHead = git('rev-parse', 'HEAD');
  git('switch', 'main');
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "rebase-main";\n',
    'utf8'
  );
  git('add', 'src/staged.ts');
  git('commit', '-m', 'rebase main');
  git('switch', 'rebase/source');
  expect(() => git('rebase', 'main')).toThrow();

  await refreshRepository();
  await expect(panel.getByText('Rebase 进行中 · 1 个未解决冲突')).toBeVisible();
  await expect(panel.getByRole('button', { name: '继续rebase' })).toBeDisabled();
  await previewConflictAbort();
  await approveOnceIfRequestedAndReturnToVersionControl();
  const staleRebaseAbortDialog = panel.getByRole('dialog');
  await expect(staleRebaseAbortDialog.getByText('中止rebase并恢复到操作前状态？')).toBeVisible();
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "changed-after-preview";\n',
    'utf8'
  );
  await staleRebaseAbortDialog.getByRole('button', { name: '确认中止' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect(
    panel.getByRole('alert').filter({ hasText: 'Git 冲突中止预检已过期' })
  ).toBeVisible();
  expect(gitOperationInProgress('rebase')).toBe(true);
  expect(git('branch', '--show-current')).toBe('');
  expect(git('rev-parse', 'HEAD')).not.toBe(preRebaseHead);
  expect(readFileSync(join(workspace, 'src', 'staged.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe(
    'export const value = "changed-after-preview";\n'
  );

  await panel.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await refreshRepository();
  await previewConflictAbort();
  await approveOnceIfRequestedAndReturnToVersionControl();
  await panel.getByRole('dialog').getByRole('button', { name: '确认中止' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitOperationInProgress('rebase')).toBe(false);
  expect(git('branch', '--show-current')).toBe('rebase/source');
  expect(git('rev-parse', 'HEAD')).toBe(preRebaseHead);
  expect(existsSync(join(workspace, 'keep-untracked.txt'))).toBe(true);

  expect(() => git('rebase', 'main')).toThrow();
  await refreshRepository();
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "rebase-resolved";\n',
    'utf8'
  );
  await refreshRepository();
  await panel.getByRole('checkbox', { name: '选择 src/staged.ts' }).check();
  await panel.getByRole('button', { name: '暂存所选项（1）' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect(panel.getByText('Rebase 进行中 · 0 个未解决冲突')).toBeVisible();
  await panel.getByRole('button', { name: '继续rebase' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitOperationInProgress('rebase')).toBe(false);
  expect(git('branch', '--show-current')).toBe('rebase/source');
  expect(git('rev-parse', 'HEAD')).not.toBe(preRebaseHead);

  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "revert-target";\n',
    'utf8'
  );
  git('add', 'src/staged.ts');
  git('commit', '-m', 'revert target');
  const revertedCommit = git('rev-parse', 'HEAD');
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "revert-later";\n',
    'utf8'
  );
  git('add', 'src/staged.ts');
  git('commit', '-m', 'revert later');
  const preRevertHead = git('rev-parse', 'HEAD');
  expect(() => git('revert', revertedCommit)).toThrow();

  await refreshRepository();
  await expect(panel.getByText('Revert 进行中 · 1 个未解决冲突')).toBeVisible();
  await expect(panel.getByRole('button', { name: '继续revert' })).toBeDisabled();
  await previewConflictAbort();
  await approveOnceIfRequestedAndReturnToVersionControl();
  await expect(panel.getByRole('dialog').getByText('中止revert并恢复到操作前状态？')).toBeVisible();
  await panel.getByRole('dialog').getByRole('button', { name: '确认中止' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitRefExists('REVERT_HEAD')).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(preRevertHead);
  expect(existsSync(join(workspace, 'keep-untracked.txt'))).toBe(true);

  expect(() => git('revert', revertedCommit)).toThrow();
  await refreshRepository();
  writeFileSync(
    join(workspace, 'src', 'staged.ts'),
    'export const value = "revert-resolved";\n',
    'utf8'
  );
  await refreshRepository();
  await panel.getByRole('checkbox', { name: '选择 src/staged.ts' }).check();
  await panel.getByRole('button', { name: '暂存所选项（1）' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect(panel.getByText('Revert 进行中 · 0 个未解决冲突')).toBeVisible();
  await panel.getByRole('button', { name: '继续revert' }).click();
  await approveOnceAndReturnToVersionControl();
  await expect.poll(() => gitRefExists('REVERT_HEAD')).toBe(false);
  expect(git('rev-parse', 'HEAD')).not.toBe(preRevertHead);
  expect(git('show', '-s', '--format=%s', 'HEAD')).toContain('Revert "revert target"');
  expect(existsSync(join(workspace, 'keep-untracked.txt'))).toBe(true);

  await appPage.screenshot({
    path: testInfo.outputPath('codepro-git-module.png'),
    fullPage: true,
  });
});
