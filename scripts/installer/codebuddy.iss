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
WizardStyle=modern light windows11 excludelightcontrols hidebevels
WizardSizePercent=115,110
Compression=lzma2/normal
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
Uninstallable=yes
UninstallDisplayName=CodeBuddy
SetupLogging=yes

[Languages]
Name: "zhCN"; MessagesFile: "{#ChineseMessages}"

[LangOptions]
DialogFontName=Microsoft YaHei UI
DialogFontSize=9
WelcomeFontName=Microsoft YaHei UI

[Messages]
SetupWindowTitle=安装 CodeBuddy
WizardSelectDir=安装 CodeBuddy
SelectDirDesc=选择安装位置，开始使用。
SelectDirLabel3=安装位置
SelectDirBrowseLabel=仅为当前用户安装。你可以更换安装文件夹。
DiskSpaceGBLabel=所需空间：[gb] GB
DiskSpaceMBLabel=所需空间：[mb] MB
ButtonInstall=安装
ButtonCancel=取消
ButtonFinish=完成
ButtonWizardBrowse=浏览…
WizardInstalling=正在安装 CodeBuddy
InstallingLabel=正在准备应用和运行所需文件，请稍候。
FinishedHeadingLabel=CodeBuddy 已准备就绪
FinishedLabel=安装完成。现在可以开始使用。
FinishedLabelNoIcons=安装完成。现在可以开始使用。
ClickFinish=

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\..\runtime\tools\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Keep Inno's native shortcut metadata; publish the selected links on Finish.
Name: "{app}\resources\CodeBuddy"; Filename: "{app}\CodeBuddy.exe"; WorkingDir: "{app}"; AppUserModelID: "local.codebuddy.desktop"

[UninstallDelete]
Type: files; Name: "{autodesktop}\CodeBuddy.lnk"
Type: files; Name: "{autoprograms}\CodeBuddy.lnk"

[Registry]
Root: HKCU; Subkey: "Software\Classes\codebuddy"; ValueType: string; ValueData: "URL:CodeBuddy Protocol"
Root: HKCU; Subkey: "Software\Classes\codebuddy"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\codebuddy\DefaultIcon"; ValueType: string; ValueData: """{app}\CodeBuddy.exe"",0"
Root: HKCU; Subkey: "Software\Classes\codebuddy\shell\open\command"; ValueType: string; ValueData: """{app}\CodeBuddy.exe"" ""%1"""

[Run]
Filename: "{app}\CodeBuddy.exe"; Description: "启动 CodeBuddy"; Flags: nowait postinstall skipifsilent

[Code]
var
  DesktopShortcut: TNewCheckBox;
  StartMenuShortcut: TNewCheckBox;
  ProgressText: TNewStaticText;
  ShortcutsApplied: Boolean;

procedure ApplyShortcutChoices;
begin
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
  { Silent installs and closing the finished page must apply the same defaults. }
  if (CurStep = ssDone) and not ShortcutsApplied then
    ApplyShortcutChoices;
end;

procedure InitializeWizard;
begin
  WizardForm.SelectDirBitmapImage.Visible := False;
  WizardForm.SelectDirLabel.Left := 0;
  WizardForm.SelectDirLabel.Top := ScaleY(16);
  WizardForm.DirEdit.Left := 0;
  WizardForm.DirEdit.Top := ScaleY(48);
  WizardForm.DirEdit.Height := ScaleY(28);
  WizardForm.DirEdit.Width := WizardForm.SelectDirPage.ClientWidth - ScaleX(96);
  WizardForm.DirBrowseButton.Left := WizardForm.DirEdit.Width + ScaleX(12);
  WizardForm.DirBrowseButton.Top := WizardForm.DirEdit.Top;
  WizardForm.DirBrowseButton.Width := ScaleX(84);
  WizardForm.DirBrowseButton.Height := WizardForm.DirEdit.Height;
  WizardForm.SelectDirBrowseLabel.Top := ScaleY(92);
  WizardForm.SelectDirBrowseLabel.Height := ScaleY(40);
  WizardForm.DiskSpaceLabel.Top := ScaleY(144);
  WizardForm.FilenameLabel.Visible := False;
  ProgressText := TNewStaticText.Create(WizardForm);
  ProgressText.Parent := WizardForm.InstallingPage;
  ProgressText.Left := WizardForm.ProgressGauge.Left;
  ProgressText.Top := WizardForm.ProgressGauge.Top + WizardForm.ProgressGauge.Height + ScaleY(12);
  ProgressText.Width := WizardForm.InstallingPage.ClientWidth;
  ProgressText.Caption := '正在安装 · 0%';
  WizardForm.WizardBitmapImage2.Visible := False;
  WizardForm.FinishedHeadingLabel.Left := ScaleX(32);
  WizardForm.FinishedHeadingLabel.Top := ScaleY(32);
  WizardForm.FinishedHeadingLabel.Width := WizardForm.FinishedPage.ClientWidth - ScaleX(64);
  WizardForm.FinishedHeadingLabel.Height := ScaleY(64);
  WizardForm.FinishedLabel.Left := ScaleX(32);
  WizardForm.FinishedLabel.Top := ScaleY(104);
  WizardForm.FinishedLabel.Width := WizardForm.FinishedHeadingLabel.Width;
  WizardForm.FinishedLabel.Height := ScaleY(36);
  DesktopShortcut := TNewCheckBox.Create(WizardForm);
  DesktopShortcut.Parent := WizardForm.FinishedPage;
  DesktopShortcut.SetBounds(ScaleX(32), ScaleY(152), WizardForm.FinishedHeadingLabel.Width, ScaleY(24));
  DesktopShortcut.Caption := '创建桌面快捷方式';
  DesktopShortcut.Checked := True;
  StartMenuShortcut := TNewCheckBox.Create(WizardForm);
  StartMenuShortcut.Parent := WizardForm.FinishedPage;
  StartMenuShortcut.SetBounds(ScaleX(32), ScaleY(184), WizardForm.FinishedHeadingLabel.Width, ScaleY(24));
  StartMenuShortcut.Caption := '添加到开始菜单';
  StartMenuShortcut.Checked := True;
  WizardForm.RunList.Left := ScaleX(32);
  WizardForm.RunList.Top := ScaleY(216);
  WizardForm.RunList.Width := WizardForm.FinishedHeadingLabel.Width;
  WizardForm.RunList.Height := ScaleY(48);
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
  Result := '';
  { The same bound must apply to silent installation, which skips page clicks. }
  if Length(AddBackslash(ExpandConstant('{app}'))) + {#MaxRelativePath} > 259 then
    Result := '安装路径过长，请选择更短的位置，例如 D:\CodeBuddy。';
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
begin
  if MaxProgress > 0 then
    ProgressText.Caption := '正在安装 · ' + IntToStr(Round(100.0 * CurProgress / MaxProgress)) + '%';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Command: String;
begin
  { A later installation may have taken over this protocol; leave it intact. }
  if (CurUninstallStep = usUninstall) and
     RegQueryStringValue(HKCU, 'Software\Classes\codebuddy\shell\open\command', '', Command) and
     (CompareText(Command, '"' + ExpandConstant('{app}\CodeBuddy.exe') + '" "%1"') = 0) then
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\codebuddy');
end;
