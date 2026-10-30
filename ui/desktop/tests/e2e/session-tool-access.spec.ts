import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron } from '@playwright/test';
import { expect, test } from './fixtures';
import { createDesktopFeedbackFixture } from './computer-feedback-fixture';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'codebuddy-session-tools-'));
const serverFile = join(fixtureRoot, 'mcp.cjs');
const receiptFile = join(fixtureRoot, 'calls.jsonl');
writeFileSync(
  serverFile,
  `const rl=require('readline').createInterface({input:process.stdin});const fs=require('fs');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'session_access',version:'1'}};
if(m.method==='tools/list')result={tools:['alpha','beta'].map(name=>({name,description:'Return a local acceptance marker '+name,inputSchema:{type:'object',properties:{},additionalProperties:false}}))};
if(m.method==='tools/call'){fs.appendFileSync(${JSON.stringify(receiptFile)},JSON.stringify({name:m.params.name})+'\\n');result={content:[{type:'text',text:'LOCAL_'+m.params.name.toUpperCase()+'_OK'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`
);
test.setTimeout(600_000);

test('Existing conversation adds computer control and custom MCP without a new chat', async ({
  appPage,
  isolatedProfileRoot,
}, info) => {
  const card = (name: string) =>
    appPage
      .locator('[data-slot="card"]')
      .filter({ has: appPage.getByRole('button', { name, exact: true }) });
  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  const computer = card('电脑控制');
  if (await computer.getByRole('switch').isChecked()) await computer.getByRole('switch').click();
  // Exclude unrelated remote services from this isolated acceptance profile.
  const remoteTab = appPage.getByRole('tab', { name: '外部 MCP', exact: true });
  await remoteTab.click();
  while (await appPage.getByRole('switch', { checked: true }).count()) {
    const before = await appPage.getByRole('switch', { checked: true }).count();
    const enabled = appPage.getByRole('switch', { checked: true }).first();
    await enabled.click();
    await expect
      .poll(() => appPage.getByRole('switch', { checked: true }).count())
      .toBeLessThan(before);
  }
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await appPage.getByTestId('chat-input').fill('只回复：会话保留测试开始。不要调用工具。');
  await appPage.getByTestId('chat-input').press('Enter');
  await expect(appPage.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await expect.poll(() => appPage.url()).toContain('resumeSessionId=');
  const sessionId = new URLSearchParams(new URL(appPage.url()).hash.split('?')[1]).get(
    'resumeSessionId'
  )!;
  await expect(appPage.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, {
    timeout: 90000,
  });
  // Reproduce the reported older session's explicit selection (new sessions
  // may inherit global defaults). All subsequent add/check actions use the UI.
  await appPage.evaluate(async (id) => {
    const modulePath = '/src/acp/session-extensions.ts';
    const api = await import(modulePath);
    await api.removeSessionExtension(id, 'qwen_computer');
  }, sessionId);
  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  await expect.poll(() => appPage.url()).toContain(`sessionId=${sessionId}`);
  await expect(computer).toContainText('请先启用此工具');
  await expect(
    computer.getByRole('button', { name: '添加到当前对话', exact: true })
  ).toBeDisabled();
  await computer.getByRole('switch').click();
  await expect(computer).toContainText('当前对话未加载');
  await computer.getByRole('button', { name: '添加到当前对话', exact: true }).click();
  await expect(computer).toContainText(/已加载 · \d+ 个工具可用/, { timeout: 60000 });
  await appPage.getByRole('button', { name: '添加自定义扩展', exact: true }).click();
  const dialog = appPage.getByRole('dialog');
  await dialog.getByPlaceholder('输入扩展名称…').fill('session_access');
  await dialog.getByPlaceholder('可选描述…').fill('Two harmless local acceptance tools');
  await dialog
    .getByPlaceholder('例如：npx -y @modelcontextprotocol/my-extension [filepath]')
    .fill(`"${process.execPath}" "${serverFile}"`);
  await dialog.getByTestId('extension-submit-btn').click();
  await expect(dialog).not.toBeVisible();
  const custom = card('session_access');
  await expect(custom).toContainText('当前对话未加载');
  await custom.getByRole('button', { name: '添加到当前对话', exact: true }).click();
  await expect(custom).toContainText('已加载 · 2 个工具可用', { timeout: 60000 });
  await appPage.screenshot({ path: info.outputPath('tools-added.png') });
  await appPage.reload();
  await expect(custom).toContainText('当前对话已添加');
  await appPage.getByRole('link', { name: '返回对话继续', exact: true }).click();
  await expect.poll(() => appPage.url()).toContain(`resumeSessionId=${sessionId}`);
  // A real local desktop window records native input. The product's model and
  // MCP perform the actions; this harness only submits the request and reads receipts.
  createDesktopFeedbackFixture(fixtureRoot);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktopFixture = await _electron.launch({ args: [join(fixtureRoot, 'fixture.cjs')], env });
  try {
    await desktopFixture.firstWindow();

    await appPage
      .getByTestId('chat-input')
      .fill(
        '工具已添加到当前对话。请调用 session_access 的 alpha 和 beta 两个工具，然后加载 computer-use 技能并调用 list_apps 只列出窗口。不要操作微信或发送消息。根据工具回执简短报告两个测试标记和窗口数量。'
      );
    await appPage.getByTestId('chat-input').press('Enter');
    await expect
      .poll(
        async () => {
          const allow = appPage.getByRole('button', { name: '仅此次允许', exact: true }).first();
          if (await allow.isVisible()) await allow.click();
          const state = JSON.parse(
            readFileSync(join(isolatedProfileRoot, '.CodeBuddy/backend/state.json'), 'utf8')
          );
          const session = state.sessions.find((s: { id: string }) => s.id === sessionId);
          return (
            session?.updates?.some(
              (u: { sessionUpdate: string; title?: string }) =>
                u.sessionUpdate === 'tool_call' && u.title?.includes('list_apps')
            ) &&
            existsSync(receiptFile) &&
            readFileSync(receiptFile, 'utf8').includes('beta')
          );
        },
        { timeout: 150000, intervals: [1000, 2000] }
      )
      .toBeTruthy();
    await expect(appPage.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, {
      timeout: 60000,
    });
    const state = JSON.parse(
      readFileSync(join(isolatedProfileRoot, '.CodeBuddy/backend/state.json'), 'utf8')
    );
    const session = state.sessions.find((s: { id: string }) => s.id === sessionId);
    expect(session.extensions).toEqual(expect.arrayContaining(['qwen_computer', 'session_access']));
    expect(readFileSync(receiptFile, 'utf8')).toContain('alpha');
    writeFileSync(
      info.outputPath('session-evidence.json'),
      JSON.stringify(
        {
          sessionId,
          extensions: session.extensions,
          updates: session.updates,
          calls: readFileSync(receiptFile, 'utf8'),
          visible: await appPage.locator('body').innerText(),
        },
        null,
        2
      )
    );
    await appPage.screenshot({ path: info.outputPath('same-conversation-result.png') });

    const fixtureState = () =>
      JSON.parse(readFileSync(join(fixtureRoot, 'fixture-state.json'), 'utf8'));
    await appPage
      .getByTestId('chat-input')
      .fill(
        '仅操作已打开的 CodeBuddy Feedback Acceptance 本地测试窗口：观察窗口后单击“点击验收按钮”，在“验收输入框”输入“本次视觉验收完成”，将“拖动块”向右拖动约100像素，然后在滚动区域向下滚动。按窗口标题选择正确目标，窗口新增或切换时重新定位。复用每步返回画面核对，不加固定等待，不操作其他应用。完成后简短报告。'
      );
    await appPage.getByTestId('chat-input').press('Enter');
    const overlays = () =>
      appPage
        .context()
        .pages()
        .filter((p) => p.url().startsWith('data:text/html') && p.url().includes('cursor-label'));
    await expect
      .poll(
        async () => {
          const allow = appPage.getByRole('button', { name: '仅此次允许', exact: true }).first();
          if (await allow.isVisible()) await allow.click();
          return overlays().length;
        },
        { timeout: 120000, intervals: [500, 1000] }
      )
      .toBe(2);
    await expect
      .poll(
        async () =>
          (
            await Promise.all(overlays().map((page) => page.locator('#pointer').isVisible()))
          ).filter(Boolean).length
      )
      .toBe(1);
    const surfaces = [];
    for (const [index, page] of overlays().entries()) {
      await expect(page.locator('.banner')).toBeVisible();
      surfaces.push(
        await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          banner: document.querySelector('.banner')!.getBoundingClientRect().toJSON(),
          pointer: getComputedStyle(document.querySelector('#pointer')!).display,
          glow: getComputedStyle(document.querySelector('.glow')!).boxShadow,
        }))
      );
      await page.screenshot({
        path: info.outputPath(`overlay-${index}.png`),
        omitBackground: true,
      });
    }
    expect(surfaces.filter((s) => s.pointer !== 'none')).toHaveLength(1);
    writeFileSync(info.outputPath('overlay-evidence.json'), JSON.stringify(surfaces, null, 2));
    await expect
      .poll(
        async () => {
          const allow = appPage.getByRole('button', { name: '仅此次允许', exact: true }).first();
          if (await allow.isVisible()) await allow.click();
          const s = fixtureState();
          return s.clicks > 0 && s.text === '本次视觉验收完成' && s.dragX > 50 && s.scroll > 0;
        },
        { timeout: 240000, intervals: [1000, 2000] }
      )
      .toBeTruthy();
    await expect(appPage.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, {
      timeout: 60000,
    });
    await expect.poll(() => overlays().length).toBe(0);
    writeFileSync(info.outputPath('desktop-receipt.json'), JSON.stringify(fixtureState(), null, 2));
    await (
      await desktopFixture.firstWindow()
    ).screenshot({ path: info.outputPath('desktop-result.png') });
    const finalState = JSON.parse(
      readFileSync(join(isolatedProfileRoot, '.CodeBuddy/backend/state.json'), 'utf8')
    );
    writeFileSync(
      info.outputPath('desktop-session-evidence.json'),
      JSON.stringify(
        finalState.sessions.find((s: { id: string }) => s.id === sessionId),
        null,
        2
      )
    );
  } finally {
    await desktopFixture.close();
  }
});
