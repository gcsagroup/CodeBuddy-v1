const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveCompiler } = require('./windows-wizard-installer.cjs');
test('production installer layout compiles, fits its pages and keeps internal paths out of component details', { timeout: 90000 }, t => {
  if (process.platform !== 'win32') return t.skip('Native Windows installer');
  const compilerTools = resolveCompiler();
  const repo = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(repo, 'target'), { recursive: true });
  const root = fs.mkdtempSync(path.join(repo, 'target/installer-ui-test-'));
  const fixtureAppId = `CodeBuddyVisualFixture-${path.basename(root)}`;
  const previousInstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${fixtureAppId}_is1`;
  const previousDirectory = path.join(root, 'previous-install');
  const seedPrevious = spawnSync('reg.exe', ['ADD', previousInstallKey, '/v', 'Inno Setup: App Path', '/t', 'REG_SZ', '/d', previousDirectory, '/reg:64'], { encoding: 'utf8', windowsHide: true });
  assert.equal(seedPrevious.status, 0, seedPrevious.stdout + seedPrevious.stderr);
  t.after(() => {
    const cleanup = spawnSync('reg.exe', ['DELETE', previousInstallKey, '/f', '/reg:64'], { encoding: 'utf8', windowsHide: true });
    assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr);
  });
  const payload = path.join(root, 'payload/resources/harness-distribution/runtime/py');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'private-package.py'), 'fixture');
  fs.writeFileSync(path.join(root, 'payload/CodeBuddy.exe'), 'fixture');
  const capture = path.join(root, 'capture.ps1');
  fs.writeFileSync(capture, `param([long]$WindowId,[string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class InstallerImage { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect); public struct Rect { public int Left, Top, Right, Bottom; } }
"@
[InstallerImage]::SetProcessDPIAware() | Out-Null
$rect = New-Object InstallerImage+Rect
if (-not [InstallerImage]::GetWindowRect([IntPtr]::new($WindowId), [ref]$rect)) { exit 2 }
$bitmap = New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
try { $captured = [InstallerImage]::PrintWindow([IntPtr]::new($WindowId), $dc, 2) }
finally { $graphics.ReleaseHdc($dc) }
if (-not $captured) { $graphics.Dispose(); $bitmap.Dispose(); exit 3 }
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
`);
  let script = fs.readFileSync(path.join(__dirname, 'installer/codebuddy.iss'), 'utf8');
  script = script.replace('AppId={{57246561-8F37-48B1-9DE6-2878918A3EBA}', `AppId=${fixtureAppId}`)
    .replace('UsePreviousAppDir=yes', 'UsePreviousAppDir=yes\nCreateUninstallRegKey=no')
    .replace('Uninstallable=yes', 'Uninstallable=no')
    .replace(/\[Registry\][\s\S]*?(?=\[Run\])/, '')
    .replaceAll('..\\..\\LICENSE', path.join(repo, 'LICENSE'))
    .replaceAll('..\\..\\runtime\\tools\\licenses', path.join(repo, 'runtime/tools/licenses'))
    .replace('procedure InitializeWizard;', 'procedure VerifyLayout; forward;\nprocedure InitializeWizard;')
    .replace('  InitializeInstallerUI;', "  InitializeInstallerUI; VerifyLayout;")
    .replaceAll('BeforeInstall: ShowInstallingFile', 'BeforeInstall: CaptureInstallingComponent')
    .replace(/#include "([^"]+)"/g, (_, file) => `#include "${path.join(__dirname, 'installer', file)}"`);
  script = `#define AppSource "${path.join(root, 'payload')}"\n#define AppVersion "1.0"\n#define OutputDir "${root}"\n#define ProductIcon "${path.join(repo, 'ui/desktop/src/images/icon.ico')}"\n#define ProductImage "${path.join(repo, 'ui/desktop/src/images/icon-512.png')}"\n#define MaxRelativePath 100\n#define StorageLocator "${path.join(root, 'bootstrap/data-root.txt')}"\n` + script;
  script += `
procedure RequireUI(Condition: Boolean; const Message: String);
begin if not Condition then RaiseException(Message); end;
procedure CaptureUI(const Name: String);
var Code: Integer;
begin
  WizardForm.Show;
  WizardForm.Repaint;
  RequireUI(Exec(ExpandConstant('{sys}\\WindowsPowerShell\\v1.0\\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "${capture}" ' + IntToStr(WizardForm.Handle) + ' "${root}\\' + Name + '.png"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0), 'Native capture failed');
end;
procedure VerifyLayout;
begin
  Log('Verifying native UI layout');
  RequireUI(WizardForm.DirEdit.Text = '${previousDirectory}', 'Installer reuses the registered previous installation directory');
  DesktopShortcut.Checked := False;
  StartMenuShortcut.Checked := False;
  LaunchOnFinish.Checked := False;
  RequireUI(InstallItemLabel.Top >= WizardForm.StatusLabel.Top + WizardForm.StatusLabel.Height, 'Component follows the current operation');
  RequireUI(InstallItemLabel.Top + InstallItemLabel.Height <= WizardForm.ProgressGauge.Top, 'Component remains above the progress bar');
  RequireUI(LaunchOnFinish.Top + LaunchOnFinish.Height <= WizardForm.FinishedPage.ClientHeight, 'Finish options overflow');
  RequireUI(WizardForm.NextButton.Top + WizardForm.NextButton.Height <= WizardForm.ClientHeight, 'Buttons overflow');
  RequireUI(WizardForm.NextButton.Height = WizardForm.CancelButton.Height, 'Primary and secondary buttons have equal height');
  RequireUI(WizardForm.NextButton.Width = WizardForm.CancelButton.Width, 'Primary and secondary buttons have equal width');
  RequireUI(WizardForm.NextButton.Top = WizardForm.CancelButton.Top, 'Footer buttons share a baseline');
  RequireUI(WizardForm.CancelButton.Left - WizardForm.NextButton.Left - WizardForm.NextButton.Width = ScaleX(8), 'Footer button gap is consistent');
  RequireUI(WizardForm.CancelButton.Left + WizardForm.CancelButton.Width = InstallerControlLeft(WizardForm.ProgressGauge) + WizardForm.ProgressGauge.Width, 'Footer aligns with the content column');
  RequireUI(WizardForm.MainPanel.Color = clWhite, 'Header shares the white page background');
  RequireUI(WizardForm.PageNameLabel.Font.Size = 10, 'Header uses a compact title');
  RequireUI(WizardForm.DirBrowseButton.Height = WizardForm.DirEdit.Height, 'Browse button matches the native path field height');
  RequireUI(WizardForm.WizardBitmapImage2.Visible, 'Finish page shows the product mark');
  RequireUI(WizardForm.WizardBitmapImage2.Left + WizardForm.WizardBitmapImage2.Width < WizardForm.FinishedHeadingLabel.Left, 'Finish mark and copy use separate columns');
  RequireUI(DesktopShortcut.Left = WizardForm.FinishedHeadingLabel.Left, 'Finish options align with the text column');
  RequireUI(InstallationComponent('resources\\harness-distribution\\runtime\\harness\\node_modules\\secret\\index.js') = '智能助手组件', 'Assistant label');
  RequireUI(InstallationComponent('resources\\harness-distribution\\runtime\\py\\private.py') = '文档处理组件', 'Document label');
  WizardForm.OuterNotebook.ActivePage := WizardForm.InnerPage;
  WizardForm.InnerNotebook.ActivePage := WizardForm.SelectDirPage;
  WizardForm.PageNameLabel.Caption := '选择安装位置';
  WizardForm.PageDescriptionLabel.Caption := '将 CodeBuddy 安装到你的电脑。';
  WizardForm.NextButton.Caption := '安装';
  WizardForm.BackButton.Visible := False;
  WizardForm.CancelButton.Caption := '取消';
  CaptureUI('location');
  WizardForm.DirEdit.Text := '${root}\\installed';
end;
procedure CaptureInstallingComponent;
begin
  ShowInstallingFile;
  if InstallationComponent(ExtractRelativePath(AddBackslash(ExpandConstant('{app}')), ExpandConstant(CurrentFilename))) = '文档处理组件' then
  begin
    RequireUI(InstallItemLabel.Caption = '文档处理组件', 'Current component is immediately visible');
    CaptureUI('progress');
  end;
end;
<event('CurStepChanged')>
procedure CaptureStages(Step: TSetupStep);
begin
  if Step = ssPostInstall then begin
    RequireUI(Pos('node_modules', InstallItemLabel.Caption) = 0, 'No package paths in UI');
    RequireUI(Pos('private-package.py', InstallItemLabel.Caption) = 0, 'No internal file names in UI');
  end
  else if Step = ssDone then begin
    WizardForm.OuterNotebook.ActivePage := WizardForm.FinishedPage;
    CurPageChanged(wpFinished);
    RequireUI(WizardForm.NextButton.Left + WizardForm.NextButton.Width = InstallerControlLeft(WizardForm.ProgressGauge) + WizardForm.ProgressGauge.Width, 'Single finish action aligns with content edge');
    CaptureUI('finish');
  end;
end;
`;
  const file = path.join(root, 'fixture.iss'); fs.writeFileSync(file, script);
  const tools = compilerTools;
  const result = spawnSync(tools.compiler, ['/Q', '/DChineseMessages=' + tools.chineseMessages, file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const run = spawnSync(path.join(root, 'CodeBuddy-Setup.exe'), ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(root, 'install.log')], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
  assert.equal(run.error, undefined); assert.equal(run.status, 0, fs.readFileSync(path.join(root, 'install.log'), 'utf8'));
  for (const name of ['location', 'progress', 'finish']) assert.ok(fs.statSync(path.join(root, name + '.png')).size > 1000);
  console.log('Native installer UI evidence: ' + root);
});
