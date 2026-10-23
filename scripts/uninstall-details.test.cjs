const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveCompiler } = require('./windows-wizard-installer.cjs');

for (const visible of [false, true]) test(`native inline uninstall observes removal and retains user data and projects (visible=${visible})`, { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Windows native Inno test');
  const tools = resolveCompiler();
  const repo = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.resolve(__dirname, '../target/uninstall-details-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(__dirname, '../target'));
    assert.ok(path.basename(root).startsWith('uninstall-details-test-'));
    if (fs.existsSync(path.join(root, 'receipt.txt'))) fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'payload.txt'), 'installed payload');
  const receipt = path.join(root, 'receipt.txt');
  const script = path.join(root, 'fixture.iss');
  const evidence = visible ? fs.mkdtempSync(path.resolve(__dirname, '../target/uninstall-ui-evidence-')) : null;
  const capture = path.join(root, 'capture.ps1');
  fs.writeFileSync(capture, `param([long]$WindowId,[string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class UninstallImage { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect); public struct Rect { public int Left, Top, Right, Bottom; } }
"@
[UninstallImage]::SetProcessDPIAware() | Out-Null
$rect = New-Object UninstallImage+Rect
if (-not [UninstallImage]::GetWindowRect([IntPtr]::new($WindowId), [ref]$rect)) { exit 2 }
$bitmap = New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
try { $captured = [UninstallImage]::PrintWindow([IntPtr]::new($WindowId), $dc, 2) }
finally { $graphics.ReleaseHdc($dc) }
if (-not $captured) { $graphics.Dispose(); $bitmap.Dispose(); exit 3 }
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
`);
  const observedInclude = path.join(root, 'observed-uninstall.iss');
  fs.writeFileSync(observedInclude, fs.readFileSync(path.join(__dirname, 'installer/uninstall-details.iss'), 'utf8')
    .replace('#include "component-labels.iss"', `#include "${path.join(__dirname, 'installer/component-labels.iss')}"`)
    .replace('  ObserveUninstallFiles(False);', '  ObserveUninstallFiles(False); CaptureRemoval;'));
  fs.writeFileSync(script, `
[Setup]
AppId=CodeBuddyUninstallDetailsFixture
AppName=CodeBuddy
AppVersion=1.0
DefaultDirName=${root}\\installed
PrivilegesRequired=lowest
UsePreviousAppDir=no
CreateUninstallRegKey=no
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
OutputDir=${root}
OutputBaseFilename=fixture
WizardStyle=modern light
WizardSmallImageFile=${path.join(repo, 'ui/desktop/src/images/icon-512.png')}
[Languages]
Name: "zhCN"; MessagesFile: "${tools.chineseMessages}"
[LangOptions]
DialogFontName=Microsoft YaHei UI
DialogFontSize=9
[Files]
Source: "${root}\\payload.txt"; DestDir: "{app}"; DestName: "中文 文件.txt"; BeforeInstall: ShowInstallingFile
Source: "${root}\\payload.txt"; DestDir: "{app}\\resources"; BeforeInstall: ShowInstallingFile
Source: "${root}\\payload.txt"; DestDir: "{app}\\resources\\harness-distribution\\runtime\\py"; DestName: "private.py"; BeforeInstall: ShowInstallingFile
Source: "${path.join(repo, 'ui/desktop/src/images/icon-512.png')}"; DestDir: "{app}\\resources"; DestName: "installer-logo.png"; BeforeInstall: ShowInstallingFile
[UninstallDelete]
Type: files; Name: "{app}\\resources\\installed-files.txt"
[Code]
var CapturedRemoval: Boolean;
procedure CaptureRemoval; forward;
#include "${path.join(__dirname, 'installer/install-details.iss')}"
#include "${observedInclude}"
procedure Require(Condition: Boolean; const Message: String);
begin
  if not Condition then RaiseException(Message);
end;
procedure CaptureUninstallWindow(const Name: String);
var Code: Integer;
begin
  UninstallProgressForm.Show;
  UninstallProgressForm.Repaint;
  Require(Exec(ExpandConstant('{sys}\\WindowsPowerShell\\v1.0\\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "${capture}" ' + IntToStr(UninstallProgressForm.Handle) + ' "${evidence}\\' + Name + '.png"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0), 'Uninstall window capture failed');
end;
procedure CaptureRemoval;
begin
  if ${visible ? 'True' : 'False'} and not CapturedRemoval and (UninstallRemovedFiles > 0) then
  begin
    CapturedRemoval := True;
    Require(UninstallFileText.Caption = UninstallDetailsComponent, 'Visible component follows observed deletion');
    CaptureUninstallWindow('uninstall-active');
  end;
end;
procedure InitializeWizard;
begin
  InitializeInstallDetails(WizardForm.ProgressGauge.Top + WizardForm.ProgressGauge.Height + ScaleY(32));
end;
procedure CurStepChanged(Step: TSetupStep);
begin
  if Step = ssPostInstall then InstalledFileIndex.SaveToFile(ExpandConstant('{app}\\resources\\installed-files.txt'));
end;
<event('CurUninstallStepChanged')>
procedure TestUninstall(Step: TUninstallStep);
var I: Integer;
begin
  if Step = usUninstall then
  begin
    Require(UninstallFileText.Visible, 'Current component is immediately visible');
    Require(UninstallFileText.Top >= UninstallProgressForm.StatusLabel.Top + UninstallProgressForm.StatusLabel.Height, 'Component follows the current operation');
    Require(UninstallFileText.Top + UninstallFileText.Height <= UninstallProgressForm.ProgressBar.Top, 'Component appears above progress');
    for I := 0 to UninstallProgressForm.InstallingPage.ControlCount - 1 do
    begin
      Require(not (UninstallProgressForm.InstallingPage.Controls[I] is TNewMemo), 'No log panel');
      Require(not (UninstallProgressForm.InstallingPage.Controls[I] is TNewButton), 'No disclosure button');
    end;
    Require(UninstallProgressForm.OuterNotebook.Top + UninstallProgressForm.OuterNotebook.Height <= UninstallProgressForm.CancelButton.Top, 'Navigation does not overlap details');
    Require(UninstallPendingFiles.Count = 4, 'Only installed files indexed');
    ${visible ? "Require(UninstallProgressForm.WizardSmallBitmapImage.PngImage.Width > 0, 'Uninstaller uses the installed product mark');" : ''}
    Require(UninstallFileText.Left = UninstallProgressForm.ProgressBar.Left, 'Component aligns with progress');
    Require(UninstallProgressForm.CancelButton.Left + UninstallProgressForm.CancelButton.Width = UninstallControlLeft(UninstallProgressForm.ProgressBar) + UninstallProgressForm.ProgressBar.Width, 'Footer aligns with the content edge');
    ObserveUninstallFiles(True);
    Require(UninstallRemovedFiles = 0, 'Existing files must not be reported removed');
    ${visible ? "CaptureUninstallWindow('uninstall-start');" : ''}
  end
  else if Step = usPostUninstall then
  begin
    ${visible ? "Require(CapturedRemoval, 'Real window timer observed and displayed actual removal');" : ''}
    FinishUninstallDetails;
    Require(UninstallDetailsTimer = 0, 'Timer stopped');
    Require(UninstallRemovedFiles = 4, 'All actual removals observed');
    Require(UninstallDetailsComponent <> '', 'An actual removal component was recorded');
    Require(Pos('中文 文件.txt', UninstallDetailsComponent) = 0, 'Internal Unicode names stay out of user details');
    Require(Pos('resources\\payload.txt', UninstallDetailsComponent) = 0, 'Internal nested paths stay out of user details');
    Require(FileExists(ExpandConstant('{app}\\my-project\\keep.txt')), 'Project inside install directory retained');
    Require(FileExists('${root}\\user-data\\chat.sqlite'), 'External application data retained');
    Require(SaveStringToFile('${receipt}.tmp', 'passed', False), 'Receipt saved');
    Require(RenameFile('${receipt}.tmp', '${receipt}'), 'Completed receipt published');
  end;
end;
`, 'utf8');
  let result = spawnSync(tools.compiler, ['/Q', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  result = spawnSync(path.join(root, 'fixture.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  fs.mkdirSync(path.join(root, 'installed/my-project'));
  fs.writeFileSync(path.join(root, 'installed/my-project/keep.txt'), 'user project');
  fs.mkdirSync(path.join(root, 'user-data'));
  fs.writeFileSync(path.join(root, 'user-data/chat.sqlite'), 'important application data');
  fs.appendFileSync(path.join(root, 'installed/resources/installed-files.txt'), '\r\n..\\..\\user-data\\chat.sqlite\r\n');
  if (!visible) fs.writeFileSync(path.join(root, 'installed/resources/installer-logo.png'), 'corrupt optional branding fixture');
  result = spawnSync(path.join(root, 'installed/unins000.exe'), [visible ? '/SILENT' : '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(receipt) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'passed');
  assert.equal(fs.existsSync(path.join(root, 'installed/中文 文件.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'installed/my-project/keep.txt'), 'utf8'), 'user project');
  assert.equal(fs.readFileSync(path.join(root, 'user-data/chat.sqlite'), 'utf8'), 'important application data');
  if (visible) {
    for (const name of ['uninstall-start', 'uninstall-active']) assert.ok(fs.statSync(path.join(evidence, name + '.png')).size > 1000);
    console.log('Native uninstall UI evidence: ' + evidence);
  }
});
