; Compile with scripts/build-harness-windows.cjs --installer=inno.
; Inno Setup owns file copying, rollback, shortcuts and uninstall registration.
#if Ver < EncodeVer(6, 7, 0)
  #error Inno Setup 6.7 or later is required
#endif
#ifndef AppSource
  #error Build through scripts/build-harness-windows.cjs
#endif

[Setup]
AppId={{57246561-8F37-48B1-9DE6-2878918A3EBA}
AppName=CodeBuddy
AppVersion={#AppVersion}
AppPublisher=CodeBuddy
VersionInfoDescription=CodeBuddy 安装程序
DefaultDirName={localappdata}\Programs\CodeBuddy
DefaultGroupName=CodeBuddy
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
UsePreviousAppDir=yes
DisableDirPage=no
DisableWelcomePage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
AllowRootDirectory=no
DirExistsWarning=auto
OutputDir={#OutputDir}
OutputBaseFilename=CodeBuddy-Setup
SetupIconFile={#ProductIcon}
UninstallDisplayIcon={app}\CodeBuddy.exe
WizardSmallImageFile={#ProductImage}
WizardImageFile=
WizardStyle=modern light
WizardSizePercent=100,100
Compression=lzma2/normal
SolidCompression=yes
CloseApplications=no
RestartApplications=no
Uninstallable=yes
UninstallDisplayName=CodeBuddy
SetupLogging=yes
UninstallLogging=yes

[Languages]
Name: "zhCN"; MessagesFile: "{#ChineseMessages}"

[LangOptions]
DialogFontName=Microsoft YaHei UI
DialogFontSize=9
WelcomeFontName=Microsoft YaHei UI

[Messages]
SetupWindowTitle=安装 CodeBuddy
WizardSelectDir=选择安装位置
SelectDirDesc=将 CodeBuddy 安装到你的电脑。
SelectDirLabel3=安装到此文件夹
SelectDirBrowseLabel=仅为当前账户安装。聊天记录和项目会保留。
DiskSpaceGBLabel=所需空间：[gb] GB
DiskSpaceMBLabel=所需空间：[mb] MB
ButtonInstall=安装
ButtonCancel=取消
ButtonFinish=完成
ButtonWizardBrowse=浏览…
WizardInstalling=正在安装 CodeBuddy
InstallingLabel=安装程序正在准备应用文件，请稍候。
FinishedHeadingLabel=CodeBuddy 安装完成
FinishedLabel=CodeBuddy 已安装到你的电脑。%n%n单击“完成”退出安装程序。
FinishedLabelNoIcons=CodeBuddy 已安装到你的电脑。%n%n单击“完成”退出安装程序。
ClickFinish=

[Files]
Source: "{#ProductImage}"; DestDir: "{app}\resources"; DestName: "installer-logo.png"; Flags: ignoreversion; BeforeInstall: ShowInstallingFile
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; BeforeInstall: ShowInstallingFile
Source: "..\..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion; BeforeInstall: ShowInstallingFile
Source: "..\..\runtime\tools\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs; BeforeInstall: ShowInstallingFile

[Icons]
; Keep Inno's native shortcut metadata; publish the selected links on Finish.
Name: "{app}\resources\CodeBuddy"; Filename: "{app}\CodeBuddy.exe"; WorkingDir: "{app}"; IconFilename: "{app}\CodeBuddy.exe"; IconIndex: 0; AppUserModelID: "com.squirrel.CodeBuddyHarness.CodeBuddy"; BeforeInstall: RecordInstallDetail('正在创建应用快捷方式')

[UninstallDelete]
Type: files; Name: "{autodesktop}\CodeBuddy.lnk"
Type: files; Name: "{autoprograms}\CodeBuddy.lnk"
Type: files; Name: "{app}\resources\installed-files.txt"

[Registry]
Root: HKCU; Subkey: "Software\Classes\codebuddy"; ValueType: string; ValueData: "URL:CodeBuddy Protocol"; BeforeInstall: RecordInstallDetail('正在注册 CodeBuddy 链接协议')
Root: HKCU; Subkey: "Software\Classes\codebuddy"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\codebuddy\DefaultIcon"; ValueType: string; ValueData: """{app}\CodeBuddy.exe"",0"
Root: HKCU; Subkey: "Software\Classes\codebuddy\shell\open\command"; ValueType: string; ValueData: """{app}\CodeBuddy.exe"" ""%1"""

[Run]
Filename: "{app}\CodeBuddy.exe"; Description: "启动 CodeBuddy"; Flags: nowait postinstall skipifsilent

[Code]
#include "install-details.iss"
#include "uninstall-details.iss"
#include "data-directory.iss"
#include "process-guard.iss"
#include "uninstall-options.iss"

var
  DesktopShortcut: TNewCheckBox;
  StartMenuShortcut: TNewCheckBox;
  LaunchOnFinish: TNewCheckBox;
  ProgressText: TNewStaticText;
  ShortcutsApplied: Boolean;

procedure ApplyShortcutChoices;
begin
  { Upgrade retains existing shortcut choices; it does not create new ones. }
  if ExpandConstant('{param:CODEBUDDYUPDATE|0}') <> '0' then
  begin
    DesktopShortcut.Checked := FileExists(ExpandConstant('{autodesktop}\CodeBuddy.lnk'));
    StartMenuShortcut.Checked := FileExists(ExpandConstant('{autoprograms}\CodeBuddy.lnk'));
  end;
  if DesktopShortcut.Checked and not FileCopy(
    ExpandConstant('{app}\resources\CodeBuddy.lnk'),
    ExpandConstant('{autodesktop}\CodeBuddy.lnk'), False) then
    RaiseException('无法创建桌面快捷方式，请检查桌面文件夹的写入权限后重试。');
  if StartMenuShortcut.Checked and not FileCopy(
    ExpandConstant('{app}\resources\CodeBuddy.lnk'),
    ExpandConstant('{autoprograms}\CodeBuddy.lnk'), False) then
    RaiseException('无法添加到开始菜单，请检查开始菜单文件夹的写入权限后重试。');
  ShortcutsApplied := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    RecordInstallDetail('开始准备 CodeBuddy')
  else if CurStep = ssPostInstall then
  begin
    InstalledFileIndex.SaveToFile(ExpandConstant('{app}\resources\installed-files.txt'));
    RecordInstallDetail('已完成 · 应用已准备就绪');
  end;
  { Silent installs and closing the finished page must apply the same defaults. }
  if (CurStep = ssDone) and not ShortcutsApplied then
    ApplyShortcutChoices;
end;

procedure LaunchOnFinishClick(Sender: TObject);
begin
  if WizardForm.RunList.Items.Count > 0 then
    WizardForm.RunList.Checked[0] := LaunchOnFinish.Checked;
end;

#include "installer-ui.iss"

procedure InitializeWizard;
begin
  InitializeInstallerUI;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  AlignInstallerFooter(CurPageID);
  if CurPageID = wpFinished then
  begin
    { Keep Inno responsible for [Run], using ordinary checkboxes for display. }
    LaunchOnFinish.Visible := WizardForm.RunList.Items.Count > 0;
    if LaunchOnFinish.Visible then
      LaunchOnFinish.Checked := WizardForm.RunList.Checked[0];
    WizardForm.RunList.Visible := False;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpFinished then
  begin
    try
      ApplyShortcutChoices;
    except
      MsgBox(GetExceptionMessage, mbError, MB_OK);
      Result := False;
    end;
  end;
  { Bundled libraries still include paths subject to the Win32 MAX_PATH limit. }
  if (CurPageID = wpSelectDir) and
     (Length(AddBackslash(WizardDirValue)) + {#MaxRelativePath} > 259) then
  begin
    MsgBox('安装路径过长，请选择更短的位置，例如 D:\CodeBuddy。', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := RunningCodeBuddyMessage;
  if Result <> '' then Exit;
  Result := ValidateDataDirectory;
  if Result <> '' then Exit;
  { The same bound must apply to silent installation, which skips page clicks. }
  if Length(AddBackslash(ExpandConstant('{app}'))) + {#MaxRelativePath} > 259 then
    Result := '安装路径过长，请选择更短的位置，例如 D:\CodeBuddy。';
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
begin
  if MaxProgress > 0 then
    ProgressText.Caption := IntToStr(Round(100.0 * CurProgress / MaxProgress)) + '%';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Command: String;
begin
  if CurUninstallStep = usUninstall then PrepareUninstallData;
  if CurUninstallStep = usPostUninstall then FinishUninstallDetails;
  { A later installation may have taken over this protocol; leave it intact. }
  if (CurUninstallStep = usUninstall) and
     RegQueryStringValue(HKCU, 'Software\Classes\codebuddy\shell\open\command', '', Command) and
     (CompareText(Command, '"' + ExpandConstant('{app}\CodeBuddy.exe') + '" "%1"') = 0) then
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\codebuddy');
end;
