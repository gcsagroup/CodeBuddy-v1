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
  const root = fs.mkdtempSync(path.join(repo, 'target/installer-ui-test-[%]_-'));
  const fixtureAppId = `CodeBuddyVisualFixture-${path.basename(root)}`;
  const previousInstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${fixtureAppId}_is1`;
  const previousDirectory = path.join(root, 'previous-install');
  const otherDirectory = path.join(root, 'other-install');
  for (const directory of [previousDirectory, otherDirectory]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'unins000.exe'), 'fixture');
  }
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
  // The fixture has its own AppId and target. Match its executable so the
  // user's running app does not block (or interfere with) this isolated test.
  const guard = path.join(root, 'fixture-process-guard.iss');
  fs.writeFileSync(guard, fs.readFileSync(path.join(__dirname, 'installer/process-guard.iss'), 'utf8')
    .replaceAll('CodeBuddy.exe', fixtureAppId + '.exe'));
  script = script.replace('AppId={{57246561-8F37-48B1-9DE6-2878918A3EBA}', `AppId=${fixtureAppId}`)
    .replace('UsePreviousAppDir=yes', 'UsePreviousAppDir=yes\nCreateUninstallRegKey=no')
    .replace('Uninstallable=yes', 'Uninstallable=no')
    .replace(/\[Registry\][\s\S]*?(?=\[Run\])/, '')
    .replaceAll('..\\..\\LICENSE', path.join(repo, 'LICENSE'))
    .replaceAll('..\\..\\runtime\\tools\\licenses', path.join(repo, 'runtime/tools/licenses'))
    .replace('procedure InitializeWizard;', 'procedure VerifyLayout; forward;\nprocedure InitializeWizard;')
    .replace('  InitializeLocationSummary;', '  InitializeLocationSummary; VerifyLayout;')
    .replaceAll('BeforeInstall: ShowInstallingFile', 'BeforeInstall: CaptureInstallingComponent')
    .replace(/#include "([^"]+)"/g, (_, file) => `#include "${file === 'process-guard.iss' ? guard : path.join(__dirname, 'installer', file)}"`);
  script = `#define AppSource "${path.join(root, 'payload')}"\n#define AppVersion "1.0"\n#define OutputDir "${root}"\n#define ProductIcon "${path.join(repo, 'ui/desktop/src/images/icon.ico')}"\n#define ProductImage "${path.join(repo, 'ui/desktop/src/images/icon-512.png')}"\n#define MaxRelativePath 100\n#define StorageLocator "${path.join(root, 'bootstrap/data-root.txt')}"\n` + script;
  script += `
procedure RequireUI(Condition: Boolean; const Message: String);
begin if not Condition then RaiseException(Message); end;
procedure CaptureUI(const Name: String);
var Code: Integer;
begin
  Log('Starting native capture: ' + Name);
  WizardForm.Show;
  WizardForm.Repaint;
  RequireUI(Exec(ExpandConstant('{sys}\\WindowsPowerShell\\v1.0\\powershell.exe'), '-NoProfile -ExecutionPolicy Bypass -File "${capture}" ' + IntToStr(WizardForm.Handle) + ' "${root}\\' + Name + '.png"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0), 'Native capture failed');
  Log('Finished native capture: ' + Name);
end;
procedure VerifyLayout;
begin
  RequireUI(WizardForm.DirEdit.Text = '${previousDirectory}', 'Installer reuses the registered previous installation directory');
  RequireUI(Pos('重新安装', WizardForm.SelectDirBrowseLabel.Caption) > 0, 'Existing user installation is identified');
  RequireUI(CheckSelectedLocation('${previousDirectory}') = '', 'Same-scope upgrade accepts the registered installation');
  RequireUI(CheckSelectedLocation('${otherDirectory}') <> '', 'Installations with separate uninstall records cannot share a folder');
  RequireUI(Pos('可用空间', FreeSpaceLabel.Caption) > 0, 'Available space is shown for this destination');
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
  { The running fixture installer is a real executable under this directory. }
  RequireUI(Pos('CodeBuddy-', RunningCodeBuddyMessageForDirectory('${root}')) > 0, 'Running executables in the target directory prevent installation');
  WizardForm.DirEdit.Text := '${root}\\installed';
  RequireUI(Pos('重新安装', WizardForm.SelectDirBrowseLabel.Caption) = 0, 'Changing destination clears the upgrade message');
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
  const dataSlice = path.join(root, 'CodeBuddy-Install-1.bin');
  const result = spawnSync(tools.compiler, ['/Q', '/DBundledData=' + dataSlice, '/DChineseMessages=' + tools.chineseMessages, file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const inner = path.join(root, 'CodeBuddy-Install.exe');
  // Exercise the real Next button and extraction path with a harmless child.
  // The probe records /ALLUSERS without requesting privileges or writing to Program Files.
  const probeScript = path.join(root, 'probe.iss');
  const marker = path.join(root, 'machine-handoff.txt');
  const parentWindow = path.join(root, 'scope-window.txt');
  fs.writeFileSync(probeScript, `[Setup]
AppName=Scope Probe
AppVersion=1
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=${root}
OutputBaseFilename=ScopeProbe
[Code]
function WindowVisible(Wnd: HWND): Boolean;
  external 'IsWindowVisible@user32.dll stdcall';
function InitializeSetup: Boolean;
var I: Integer; Raw: AnsiString;
begin
  if not LoadStringFromFile('${parentWindow}', Raw) then Exit;
  if WindowVisible(StrToInt(String(Raw))) then Exit;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/ALLUSERS') = 0 then SaveStringToFile('${marker}', 'machine', False);
  Result := False;
end;`);
  const compile = (...args) => {
    const built = spawnSync(tools.compiler, ['/Q', ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(built.status, 0, built.stdout + built.stderr);
  };
  compile(probeScript);
  const scopeFile = path.join(__dirname, 'installer/scope-page.iss');
  const launcherFile = path.join(__dirname, 'installer/scope-launcher.iss');
  const launcher = fs.readFileSync(launcherFile, 'utf8')
    .replace('#include "scope-page.iss"', '#include "' + scopeFile + '"')
    .replace('  UpdateScopeShield(CurPageID);', `  UpdateScopeShield(CurPageID);
  if CurPageID = ScopePage.ID then begin
    if not Personal.Checked then RaiseException('Wrong default');
    Machine.Checked := True;
    SaveStringToFile('${parentWindow}', AnsiString(IntToStr(WizardForm.Handle)), False);
    PostMessage(WizardForm.NextButton.Handle, 245, 0, 0);
  end;`)
    .replace('    Result := HandoffComplete;', `    if not FileExists('${marker}') then RaiseException('Child did not receive all-users scope');
    if not WizardForm.Visible then RaiseException('Cancellation must restore the selector');
    if InnerResult = 0 then RaiseException('Canceled child reported success');
    if Pos('安装未完成', StatusText.Caption) = 0 then RaiseException('Missing retry feedback');
    HandoffComplete := True;
    Result := True;`);
  const wrapperScript = path.join(root, 'scope-fixture.iss');
  fs.writeFileSync(wrapperScript, launcher);
  const buildLauncher = (script, payload) => compile('/DInnerSetup=' + payload, '/DBundledData=' + dataSlice, '/DOutputDir=' + root,
    '/DProductIcon=' + path.join(repo, 'ui/desktop/src/images/icon.ico'),
    '/DProductImage=' + path.join(repo, 'ui/desktop/src/images/icon-512.png'),
    '/DChineseMessages=' + tools.chineseMessages, '/DAppVersion=1.0', script);
  buildLauncher(wrapperScript, path.join(root, 'ScopeProbe.exe'));
  const preview = spawnSync(path.join(root, 'CodeBuddy-Setup.exe'), [], { timeout: 12000 });
  assert.equal(preview.error, undefined);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'machine');
  assert.equal(preview.status, 1);
  buildLauncher(launcherFile, inner);
  // Exercise a self-contained download; the inner can only use its published slice.
  fs.renameSync(dataSlice, path.join(root, 'compiled-slice.saved'));
  const run = spawnSync(path.join(root, 'CodeBuddy-Setup.exe'), ['/CURRENTUSER', '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(root, 'install.log')], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
  assert.equal(run.error, undefined); assert.equal(run.status, 0, fs.readFileSync(path.join(root, 'install.log'), 'utf8'));
  assert.ok(fs.readFileSync(path.join(root, 'install.log'), 'utf8').includes('Application data ready'));
  const forwardedLog = path.join(root, 'inner update.log');
  const wrapped = spawnSync(path.join(root, 'CodeBuddy-Setup.exe'), ['/CURRENTUSER', '/VERYSILENT',
    '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + forwardedLog, '/DIR=' + previousDirectory],
    { encoding: 'utf8', windowsHide: true, timeout: 45000 });
  assert.equal(wrapped.status, 0, wrapped.error?.message ?? wrapped.stderr);
  const forwarded = fs.readFileSync(forwardedLog + '.install.log', 'utf8');
  assert.ok(forwarded.includes('CodeBuddy-Install.exe') && forwarded.includes(previousDirectory));
  for (const name of ['location', 'progress', 'finish']) assert.ok(fs.statSync(path.join(root, name + '.png')).size > 1000);
  console.log('Native installer UI evidence: ' + root);
});
