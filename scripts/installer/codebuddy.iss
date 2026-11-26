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
DefaultDirName={autopf}\CodeBuddy
DefaultGroupName=CodeBuddy
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
UsePreviousPrivileges=no
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
OutputBaseFilename=CodeBuddy-Install
#ifdef BundledData
DiskSpanning=yes
DiskSliceSize=max
#endif
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
SetupWindowTitle=CodeBuddy 安装
WizardSelectDir=选择安装位置
SelectDirDesc=选择 CodeBuddy 的安装文件夹。
SelectDirLabel3=安装程序将把 CodeBuddy 安装到以下目录。要安装到其他位置，请点击“浏览”并选择文件夹。点击“安装”开始。
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
Root: HKA; Subkey: "Software\Classes\codebuddy"; ValueType: string; ValueData: "URL:CodeBuddy Protocol"; BeforeInstall: RecordInstallDetail('正在注册 CodeBuddy 链接协议')
Root: HKA; Subkey: "Software\Classes\codebuddy"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\codebuddy\DefaultIcon"; ValueType: string; ValueData: """{app}\CodeBuddy.exe"",0"
Root: HKA; Subkey: "Software\Classes\codebuddy\shell\open\command"; ValueType: string; ValueData: """{app}\CodeBuddy.exe"" ""%1"""

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
  InitializeLocationSummary;
  WizardForm.Left := StrToIntDef(ExpandConstant('{param:WIZARDX|}'), WizardForm.Left);
  WizardForm.Top := StrToIntDef(ExpandConstant('{param:WIZARDY|}'), WizardForm.Top);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  AlignInstallerFooter(CurPageID);
  if CurPageID = wpSelectDir then WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
  if CurPageID = wpFinished then
  begin
    { Keep Inno responsible for [Run], using ordinary checkboxes for display. }
    LaunchOnFinish.Visible := WizardForm.RunList.Items.Count > 0;
    if LaunchOnFinish.Visible then
      LaunchOnFinish.Checked := WizardForm.RunList.Checked[0];
    WizardForm.RunList.Visible := False;
  end;
end;

#include "install-location.iss"

function CheckSelectedLocation(const Target: String): String;
begin
  Result := InstallLocationProblem(Target);
  if Result <> '' then Exit;
  if SameInstallDirectory(Target, OtherScopeDirectory) then begin
    if IsAdminInstallMode then
      Result := '此目录是 CodeBuddy 的“仅为我安装”版本：' + #13#10 + Target + #13#10#13#10 +
        '要覆盖升级，请关闭当前安装向导，在安装选项中选择“仅为我安装”，再使用此目录。'
    else
      Result := '此目录是 CodeBuddy 的“所有用户”版本：' + #13#10 + Target + #13#10#13#10 +
        '要覆盖升级，请关闭当前安装向导，在安装选项中选择“所有用户”，再使用此目录。';
    Result := Result + #13#10 + '无需先卸载，现有用户数据会保留。';
    Exit;
  end;
  if SameInstallDirectory(Target, PreviousScopeDirectory) then Exit;
  if FileExists(AddBackslash(Target) + 'unins000.exe') then
    Result := '此目录中存在卸载程序，但未找到与当前安装范围匹配的 CodeBuddy 安装记录：' + #13#10 + Target + #13#10#13#10 +
      '为避免覆盖其他安装，暂时不能写入。请返回安装选项确认原来的安装范围和目录，或选择一个新目录。' + #13#10 + '不要手动删除卸载程序；这不会修复安装记录。';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
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
  if CurPageID = wpSelectDir then
  begin
    Problem := CheckSelectedLocation(WizardDirValue);
    if Problem <> '' then
    begin
      if not WizardSilent then MsgBox(Problem, mbError, MB_OK);
      Log(Problem);
      Result := False;
    end;
  end;
end;

#ifdef BundledData
function PreparationTick: Int64;
  external 'GetTickCount64@kernel32.dll stdcall';
#endif
function PrepareToInstall(var NeedsRestart: Boolean): String;
#ifdef BundledData
var
  Waiting: TOutputMarqueeProgressWizardPage;
  SourceDirectory: String;
  Started: Int64;
#endif
begin
  Result := RunningCodeBuddyMessage;
  if Result <> '' then Exit;
  Result := CheckSelectedLocation(ExpandConstant('{app}'));
  if Result <> '' then Exit;
  Result := ValidateDataDirectory;
#ifdef BundledData
  if Result <> '' then Exit;
  SourceDirectory := AddBackslash(ExpandConstant('{src}'));
  if FileExists(SourceDirectory + 'CodeBuddy-Install-1.bin') then Exit;
  { A fast click or a silent update can reach Install while the hidden
    launcher is still preparing the disk slice. Never read a partial file. }
  Waiting := CreateOutputMarqueeProgressPage('正在安装 CodeBuddy', '正在准备应用文件…');
  Waiting.Show;
  try
    Started := PreparationTick;
    while not FileExists(SourceDirectory + 'CodeBuddy-Install-1.bin') do begin
      if FileExists(SourceDirectory + 'prepare.failed') or (PreparationTick - Started >= 120000) then begin
        Result := '无法准备应用文件。请检查临时目录的可用空间，然后重试。';
        Exit;
      end;
      Waiting.Animate;
      Sleep(40);
    end;
  finally
    Waiting.Hide;
    Waiting.Free;
  end;
#endif
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
     RegQueryStringValue(HKA, 'Software\Classes\codebuddy\shell\open\command', '', Command) and
     (CompareText(Command, '"' + ExpandConstant('{app}\CodeBuddy.exe') + '" "%1"') = 0) then
    RegDeleteKeyIncludingSubkeys(HKA, 'Software\Classes\codebuddy');
end;
