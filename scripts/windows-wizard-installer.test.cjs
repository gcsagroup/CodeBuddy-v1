const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildOptions, resolveCompiler, inspectApplication, stageInstallerApplication } = require('./windows-wizard-installer.cjs');

test('native installer has no data selection page, uses the default and preserves existing UTF-8 locations', { timeout: 60000 }, t => {
  if (process.platform !== 'win32') return t.skip('Requires the native Windows Inno compiler');
  let tools;
  try { tools = resolveCompiler(); } catch (error) { return t.skip(error.message); }
  const repo = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(repo, 'target/installer-storage-test-'));
  const locator = path.join(root, 'bootstrap/data-root.txt');
  const previous = path.join(root, 'previous');
  const selected = path.join(root, '用户 数据');
  fs.mkdirSync(path.dirname(locator));
  const include = path.join(__dirname, 'installer/data-directory.iss');
  assert.doesNotMatch(fs.readFileSync(include, 'utf8'), /CreateInputDirPage|param:DATADIR|SaveDataDirectory/);
  const script = path.join(root, 'fixture.iss');
  fs.writeFileSync(script, `
#define StorageLocator "${locator}"
[Setup]
AppId=CodeBuddyStorageDirectoryFixture
AppName=Storage Directory Fixture
AppVersion=1.0
DefaultDirName={src}\\program
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
OutputDir=${root}
OutputBaseFilename=fixture
[Code]
#include "${path.join(__dirname, 'installer/data-directory.iss')}"
procedure Require(Condition: Boolean; const Message: String);
begin
  if not Condition then RaiseException(Message);
end;
procedure InitializeWizard;
begin
  if not FileExists(StorageLocationFile) then
  begin
    Require(ReadStorageLocation = ExpandConstant('{%USERPROFILE}\\.CodeBuddy'), 'Fresh install uses the runtime default');
    Require(ValidateDataDirectory = '', 'Default data root is independent of the program');
    Require(not FileExists(StorageLocationFile), 'Validation must not create a locator');
    SaveStringToFile(StorageLocationFile, UTF8Encode('${selected}' + #13#10), False);
  end;
  Require(ReadStorageLocation = '${selected}', 'Upgrade must read the existing Unicode location');
  ForceDirectories('${selected}');
  SaveStringToFile('${selected}\\retained.txt', 'important data', False);
  WizardForm.DirEdit.Text := '${selected}\\program';
  Require(ValidateDataDirectory <> '', 'Program cannot be installed inside user data');
  WizardForm.DirEdit.Text := '${root}\\program';
  Require(ValidateDataDirectory = '', 'Upgrade keeps the existing data root');
  Require(FileExists('${selected}\\retained.txt'), 'Existing data must be retained');
end;
`, 'utf8');
  const compile = spawnSync(tools.compiler, ['/Q', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compile.error, undefined);
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  for (const extra of [[], ['/DATADIR=' + previous]]) {
    const run = spawnSync(path.join(root, 'fixture.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(root, 'install.log')}`, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, fs.readFileSync(path.join(root, 'install.log'), 'utf8'));
  }
  assert.equal(fs.readFileSync(locator, 'utf8').trim(), selected);
  assert.equal(fs.readFileSync(path.join(selected, 'retained.txt'), 'utf8'), 'important data');
});

test('installer selection does not mistake a flag for the stage path or break Squirrel continuation', () => {
  assert.deepEqual(buildOptions(['--installer=inno']), { installer: 'inno', stage: undefined, makeOnly: false, finalizeOnly: false });
  assert.deepEqual(buildOptions(['C:/stage', '--make-only']), { installer: 'squirrel', stage: 'C:/stage', makeOnly: true, finalizeOnly: false });
  assert.equal(buildOptions(['--finalize-only']).installer, 'squirrel');
  assert.throws(() => buildOptions(['--installer=inno', '--finalize-only']), /only available for Squirrel/);
  assert.throws(() => buildOptions(['--installer=unknown']), /inno or squirrel/);
  assert.throws(() => buildOptions(['--install']), /Usage/);
});

test('missing compiler and translation are explicit errors, without downloading or installing tools', t => {
  assert.throws(() => resolveCompiler({}), /never installs tools automatically/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-installer-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiler = path.join(root, 'ISCC.exe');
  fs.writeFileSync(compiler, 'compiler fixture');
  assert.throws(() => resolveCompiler({ CODEBUDDY_ISCC: compiler }), /ChineseSimplified/);
  const messages = path.join(root, 'ChineseSimplified.isl');
  fs.writeFileSync(messages, 'translation fixture');
  assert.deepEqual(resolveCompiler({ CODEBUDDY_ISCC: compiler, CODEBUDDY_INNO_ZH_CN: messages }), { compiler, chineseMessages: messages });
});

function application(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-installer-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packaged = path.join(root, 'application');
  const distribution = path.join(packaged, 'resources/harness-distribution');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(distribution, { recursive: true });
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(packaged, 'CodeBuddy.exe'), 'desktop fixture');
  fs.writeFileSync(path.join(packaged, 'resources/app.asar'), 'asar fixture');
  fs.writeFileSync(path.join(distribution, 'runtime.mjs'), 'runtime fixture');
  const sha256 = crypto.createHash('sha256').update('runtime fixture').digest('hex');
  const manifest = JSON.stringify({ engine: 'deepseek-harness', schemaVersion: 1, sourceDigest: 'fixture-digest', files: [{ path: 'runtime.mjs', sha256 }] });
  for (const directory of [stage, distribution]) fs.writeFileSync(path.join(directory, 'manifest.json'), manifest);
  return { packaged, stage, distribution };
}

test('installer input binds every runtime file to the stage and measures the actual relative install paths', t => {
  const { packaged, stage } = application(t);
  const result = inspectApplication(packaged, stage);
  assert.equal(result.files, 4);
  assert.equal(result.sourceDigest, 'fixture-digest');
  assert.equal(result.longestRelativePath, 'resources/harness-distribution/manifest.json'.length);
  assert.match(result.appAsarSha256, /^[a-f0-9]{64}$/);
});

test('runtime tampering and a different staged candidate prevent installer generation', t => {
  const { packaged, stage, distribution } = application(t);
  fs.writeFileSync(path.join(distribution, 'runtime.mjs'), 'different bytes');
  assert.throws(() => inspectApplication(packaged, stage), /identity mismatch/);
  fs.writeFileSync(path.join(stage, 'manifest.json'), '{}');
  assert.throws(() => inspectApplication(packaged, stage), /does not match/);
});

test('long compiler source paths use a short copy of the same verified application', t => {
  const { packaged, stage } = application(t);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-copy-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  assert.equal(stageInstallerApplication(packaged, 20, temporary), packaged);
  const copied = stageInstallerApplication(packaged, 259 - packaged.length, temporary);
  assert.notEqual(copied, packaged);
  assert.deepEqual(inspectApplication(copied, stage), inspectApplication(packaged, stage));
  assert.equal(fs.readFileSync(path.join(copied, 'CodeBuddy.exe'), 'utf8'), 'desktop fixture');
});

test('native installer shows one current component above progress and keeps Unicode paths in its private index', { timeout: 60000 }, t => {
  if (process.platform !== 'win32') return t.skip('Requires the native Windows Inno compiler');
  let tools;
  try { tools = resolveCompiler(); } catch (error) { return t.skip(error.message); }
  const repo = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(repo, 'target/installer-details-test-'));
  const include = path.join(__dirname, 'installer/install-details.iss');
  const script = path.join(root, 'fixture.iss');
  fs.writeFileSync(path.join(root, 'payload.txt'), 'fixture contents');
  fs.writeFileSync(script, `
[Setup]
AppId=CodeBuddyInstallerDetailsFixture
AppName=Installer Details Fixture
AppVersion=1.0
DefaultDirName={src}\\installed
UsePreviousAppDir=no
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
OutputDir=${root}
OutputBaseFilename=fixture
[Files]
Source: "${root}\\payload.txt"; DestDir: "{app}"; DestName: "中文.txt"; BeforeInstall: ShowInstallingFile
Source: "${root}\\payload.txt"; DestDir: "{app}\\nested"; BeforeInstall: ShowInstallingFile
[Code]
#include "${include}"
procedure Require(Condition: Boolean; const Message: String);
begin
  if not Condition then RaiseException(Message);
end;
procedure InitializeWizard;
var I: Integer;
begin
  WizardForm.ProgressGauge.Top := ScaleY(80);
  InitializeInstallDetails(ScaleY(40));
  Require(InstallItemLabel.Visible, 'Current component is visible without expansion');
  Require(InstallItemLabel.Top + InstallItemLabel.Height <= WizardForm.ProgressGauge.Top, 'Current component appears above progress');
  RecordInstallDetail('fixture start');
  Require(InstallItemLabel.Caption = 'fixture start', 'Current operation is immediately displayed');
  for I := 1 to 250 do RecordInstallDetail(IntToStr(I));
  Require(InstallItemLabel.Caption = '250', 'Only the latest operation remains on screen');
end;
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    Require(InstallItemLabel.Caption = '应用界面', 'UI must describe a component, not internal files');
    Require(InstalledFileIndex.IndexOf('中文.txt') >= 0, 'Actual Unicode path stays in the private uninstall index');
    Require(InstalledFileIndex.IndexOf('nested\\payload.txt') >= 0, 'Actual nested path stays in the private uninstall index');
    Require(Pos('payload.txt', InstallItemLabel.Caption) = 0, 'Internal paths must not appear in the status');
    Require(SaveStringToFile(ExpandConstant('{src}\\runtime-receipt.json'), '{"passed":true}', False), 'Receipt must be saved');
  end;
end;
`, 'utf8');
  const compile = spawnSync(tools.compiler, ['/Q', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compile.error, undefined);
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const run = spawnSync(path.join(root, 'fixture.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(root, 'install.log')}`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, fs.readFileSync(path.join(root, 'install.log'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'runtime-receipt.json'), 'utf8')), { passed: true });
  assert.equal(fs.readFileSync(path.join(root, 'installed/中文.txt'), 'utf8'), 'fixture contents');
  assert.equal(fs.readFileSync(path.join(root, 'installed/nested/payload.txt'), 'utf8'), 'fixture contents');
});
