import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expect, test } from './fixtures';

const temporaryRoot = resolve(tmpdir());
function createTemporaryProject(prefix: string): string {
  const project = resolve(mkdtempSync(join(temporaryRoot, prefix)));
  const relativeProject = relative(temporaryRoot, project);
  if (
    !isAbsolute(project) ||
    !relativeProject ||
    relativeProject === '..' ||
    relativeProject.startsWith(`..${sep}`) ||
    isAbsolute(relativeProject)
  ) {
    throw new Error(
      'Project Memory E2E workspace must be a unique child of the temporary directory'
    );
  }
  return project;
}

const projectA = createTemporaryProject('codepro-project-memory-e2e-');
const uiSelectedProject = createTemporaryProject('codepro-project-memory-ui-e2e-');
const rulesProject = createTemporaryProject('codepro-project-rules-e2e-');
writeFileSync(join(rulesProject, 'AGENTS.md'), 'initial project rule\n', 'utf8');

test.use({ initialWorkingDir: projectA });
test.setTimeout(480_000);
test.afterAll(() => {
  rmSync(projectA, { recursive: true, force: true });
  rmSync(uiSelectedProject, { recursive: true, force: true });
  rmSync(rulesProject, { recursive: true, force: true });
});

async function selectProject(page: Page, workingDir: string) {
  const label = basename(workingDir);
  await page.evaluate((dir) => window.electron.addRecentDir(dir), workingDir);
  await page.getByRole('button', { name: '请选择目录' }).click();
  await page.getByRole('menuitem').filter({ hasText: label }).click();
  const useFolder = page.getByRole('button', { name: '使用这个文件夹', exact: true });
  if (
    await useFolder
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await useFolder.click();
  }
  await expect(page.getByRole('button', { name: label }).last()).toBeVisible();
}

async function startNewConversation(page: Page, workingDir: string) {
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(page.locator('[data-testid="chat-input"]:visible').last()).toBeVisible();
  await selectProject(page, workingDir);
}

async function sendAndExpect(
  page: Page,
  prompt: string,
  expectedReply: string,
  approveWrite = false
) {
  const input = page.locator('[data-testid="chat-input"]:visible');
  await input.fill(prompt);
  await input.press('Enter');
  const useFolder = page.getByRole('button', { name: '使用这个文件夹', exact: true });
  if (
    await useFolder
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await useFolder.click();
  }
  if (approveWrite) {
    const allowOnce = page.getByRole('button', { name: '仅此次允许', exact: true });
    await expect(allowOnce).toBeVisible({ timeout: 120_000 });
    await allowOnce.click();
  }
  await expect(page.getByText(expectedReply, { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });
}

function findMemoryDocuments(root: string): string[] {
  const documents: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'memory.json') documents.push(path);
    }
  };
  visit(root);
  return documents;
}

test('Project Memory recall survives a new conversation and stays project-scoped', async ({
  appPage,
  isolatedProfileRoot,
}, testInfo) => {
  const projectB = join(isolatedProfileRoot, 'memory-project-b');
  const memoryRoot = join(isolatedProfileRoot, '.CodeBuddy', 'profiles', 'local', 'memory');
  const subject = 'acceptance_project_marker';
  const marker = 'memory-marker-90210';
  mkdirSync(projectB, { recursive: true });

  await selectProject(appPage, projectA);
  await sendAndExpect(
    appPage,
    `Project memory: MEMORY_ACCEPT remember subject=${subject} marker=${marker} reply=remembered`,
    `MEMORY_ASSISTANT_RESULT reply=remembered MEMORY_REMEMBERED ${marker}`,
    true
  );

  let persistedDocuments: string[] = [];
  await expect
    .poll(() => {
      try {
        persistedDocuments = findMemoryDocuments(memoryRoot).filter((path) =>
          readFileSync(path, 'utf8').includes(marker)
        );
        return persistedDocuments.length;
      } catch {
        return 0;
      }
    })
    .toBe(1);

  await startNewConversation(appPage, projectA);
  await sendAndExpect(
    appPage,
    `Project memory search: MEMORY_ACCEPT auto-context subject=${subject} reply=same-project`,
    'MEMORY_ASSISTANT_RESULT reply=same-project MEMORY_AUTO_CONTEXT_PRESENT'
  );

  await startNewConversation(appPage, projectB);
  await sendAndExpect(
    appPage,
    `Project memory search: MEMORY_ACCEPT auto-context subject=${subject} reply=other-project`,
    'MEMORY_ASSISTANT_RESULT reply=other-project MEMORY_AUTO_CONTEXT_ABSENT'
  );

  const screenshot = testInfo.outputPath('project-memory-isolation.png');
  await appPage.screenshot({ path: screenshot, fullPage: true });
  const evidence = testInfo.outputPath('project-memory-evidence.json');
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        marker,
        persistedDocuments: persistedDocuments.map((path) => relative(memoryRoot, path)),
        sameProjectNewConversation: 'MEMORY_AUTO_CONTEXT_PRESENT',
        otherProjectNewConversation: 'MEMORY_AUTO_CONTEXT_ABSENT',
      },
      null,
      2
    ),
    'utf8'
  );
  await testInfo.attach('project-memory-evidence', {
    path: evidence,
    contentType: 'application/json',
  });
  await testInfo.attach('project-memory-isolation', {
    path: screenshot,
    contentType: 'image/png',
  });
});

test.describe('UI-selected project binding', () => {
  test.use({ initialWorkingDir: '' });

  test('Project Memory activates after selecting a project in the UI', async ({
    appPage,
    isolatedProfileRoot,
  }, testInfo) => {
    const marker = 'memory-ui-binding-marker-58103';
    const memoryRoot = join(isolatedProfileRoot, '.CodeBuddy', 'profiles', 'local', 'memory');

    await selectProject(appPage, uiSelectedProject);
    await sendAndExpect(
      appPage,
      `Project memory: MEMORY_ACCEPT remember subject=ui_binding_marker marker=${marker} reply=ui-bound`,
      `MEMORY_ASSISTANT_RESULT reply=ui-bound MEMORY_REMEMBERED ${marker}`,
      true
    );

    let persistedDocuments: string[] = [];
    await expect
      .poll(() => {
        try {
          persistedDocuments = findMemoryDocuments(memoryRoot).filter((path) =>
            readFileSync(path, 'utf8').includes(marker)
          );
          return persistedDocuments.length;
        } catch {
          return 0;
        }
      })
      .toBe(1);

    const screenshot = testInfo.outputPath('project-memory-ui-binding.png');
    await appPage.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('project-memory-ui-binding', {
      path: screenshot,
      contentType: 'image/png',
    });
  });
});

test.describe('Project instruction conflict protection', () => {
  test.use({ initialWorkingDir: rulesProject });

  test('Project Memory settings refuse to overwrite an externally changed AGENTS.md', async ({
    appPage,
  }, testInfo) => {
    const agentsPath = join(rulesProject, 'AGENTS.md');
    const draft = 'unsaved project rule draft';
    const external = 'newer external project rule\n';

    await selectProject(appPage, rulesProject);
    await appPage.getByRole('button', { name: '设置', exact: true }).click();
    await expect(
      appPage.getByTestId('settings-navigation').getByRole('heading', { name: '设置' })
    ).toBeVisible();
    await appPage.getByTestId('settings-nav-chat').click();

    const configure = appPage.getByRole('button', { name: '配置', exact: true });
    await expect(configure).toBeEnabled();
    await configure.click();

    const dialog = appPage.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: '项目说明（AGENTS.md）', exact: true })
    ).toBeVisible();
    const editor = dialog.getByPlaceholder('在此输入项目说明…');
    await expect(editor).toHaveValue('initial project rule\n');
    await editor.fill(draft);

    writeFileSync(agentsPath, external, 'utf8');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();

    await expect(dialog.getByRole('alert')).toHaveText(
      'AGENTS.md 在保存检查前已被修改。请重新加载后再保存，以免覆盖较新的版本。'
    );
    await expect(editor).toHaveValue(draft);
    expect(readFileSync(agentsPath, 'utf8')).toBe(external);

    const screenshot = testInfo.outputPath('project-instructions-conflict.png');
    await appPage.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('project-instructions-conflict', {
      path: screenshot,
      contentType: 'image/png',
    });
  });
});
