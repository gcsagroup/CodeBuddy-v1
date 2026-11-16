import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base } from './fixtures';
import { startDeterministicOpenAiServer } from './deterministic-openai-server';

const test = base.extend<{ model: Awaited<ReturnType<typeof startDeterministicOpenAiServer>> }>({
  model: async ({}, use) => {
    const server = await startDeterministicOpenAiServer();
    try { await use(server); } finally { await server.close(); }
  },
  isolatedProfileRoot: async ({ isolatedProfileRoot, model }, use) => {
    const backend = join(isolatedProfileRoot, '.CodeBuddy', 'backend');
    mkdirSync(backend, { recursive: true });
    const providerId = 'custom_local_test';
    writeFileSync(join(backend, 'state.json'), JSON.stringify({
      version: 1, revision: 0, sessions: [], extensions: [], config: {}, preferences: {},
      defaults: { providerId, modelId: 'codepro-e2e' },
      providers: [{ id: providerId, engine: 'openai_compatible', displayName: 'Local test model',
        apiUrl: model.baseUrl, models: ['codepro-e2e'], requiresAuth: false, supportsStreaming: true }],
    }));
    await use(isolatedProfileRoot);
  },
});
test.use({ networkConsentGranted: false });
test.setTimeout(240_000);

// Only act on the permission dialog owned by this isolated Electron process.
async function chooseNativeButton(pid: number, choice: 'allow' | 'cancel') {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type 'using System; using System.Runtime.InteropServices; public static class Pointer { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,int m,IntPtr w,IntPtr l); }'
$scope = [Windows.Automation.TreeScope]
$any = [Windows.Automation.Condition]::TrueCondition
$root = [Windows.Automation.AutomationElement]::RootElement
$dialogClass = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')
$until = [DateTime]::UtcNow.AddSeconds(20)
do {
  foreach ($owner in $root.FindAll($scope::Children,$any)) {
    if ($owner.Current.ProcessId -ne ${pid}) { continue }
    $window = $owner.FindFirst($scope::Subtree,$dialogClass)
    if (-not $window) { continue }
    $id = [Windows.Automation.AutomationElement]::AutomationIdProperty
    $instruction = $window.FindFirst($scope::Descendants,[Windows.Automation.PropertyCondition]::new($id,'MainInstruction'))
    if (-not $instruction -or $instruction.Current.Name -notlike '*CodeBuddy*') { continue }
    $button = $window.FindFirst($scope::Descendants,[Windows.Automation.PropertyCondition]::new($id,'CommandButton_${choice === 'allow' ? 100 : 101}'))
    if ($button) {
      $h = [IntPtr]$button.Current.NativeWindowHandle
      [void][Pointer]::PostMessage($h,513,[IntPtr]1,[IntPtr]655370)
      [void][Pointer]::PostMessage($h,514,[IntPtr]0,[IntPtr]655370)
      exit 0
    }
  }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $until)
throw 'Permission dialog or button missing'
`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30_000 });
}

test('Network consent waits for Send, preserves a cancelled draft and remembers Allow', async ({
  appPage: page, model, isolatedProfileRoot,
}) => {
  test.skip(process.platform !== 'win32', 'Windows native dialog');
  const cdp = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  const pid = processInfo.find(p => p.type === 'browser')!.id;
  const workspace = join(isolatedProfileRoot, 'consent-workspace');
  mkdirSync(workspace);
  await page.evaluate(dir => window.electron.addRecentDir(dir), workspace);
  await page.reload();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(选择工作区|请选择目录)$/ }).click();
  await page.getByRole('menuitem').filter({ hasText: 'consent-workspace' }).click();
  const input = page.getByTestId('chat-input');
  await input.fill('回复本地测试确认');
  expect(model.requestCount()).toBe(0);
  await input.press('Enter');
  await chooseNativeButton(pid, 'cancel');
  await expect.poll(() => input.evaluate(el => el instanceof HTMLTextAreaElement ? el.value : el.textContent)).toBe('回复本地测试确认');
  expect(await page.evaluate(() => window.electron.getSetting('networkAccessAllowed'))).not.toBe(true);
  expect(model.requestCount()).toBe(0);
  const nextWindow = page.context().waitForEvent('page');
  await page.evaluate(dir => window.electron.createChatWindow({ dir }), workspace);
  const second = await nextWindow;
  await second.waitForFunction(() => typeof window.electron?.requestNetworkAccess === 'function');
  await page.bringToFront();
  await input.press('Enter');
  // Both renderer requests must resolve from one native Allow action.
  const [secondAllowed] = await Promise.all([
    second.evaluate(() => window.electron.requestNetworkAccess()),
    chooseNativeButton(pid, 'allow'),
  ]);
  expect(secondAllowed).toBe(true);
  expect(await second.evaluate(() => window.electron.getSetting('networkAccessAllowed'))).toBe(true);
  await expect(page.getByText('CodePro 本地测试响应：已收到请求。', { exact: true }).first()).toBeVisible({ timeout: 70_000 });
  expect(model.requestCount()).toBeGreaterThan(0);
  await page.reload();
  expect(await page.evaluate(() => window.electron.requestNetworkAccess())).toBe(true);
});
