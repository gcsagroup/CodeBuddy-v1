{ Shared native layout, also compiled by the isolated installer UI tests. }
var
  PreviousScopeDirectory, OtherScopeDirectory: String;
  ScopeDescription: String;
  FreeSpaceLabel: TNewStaticText;

function NormalizedInstallDirectory(const Directory: String): String;
begin
  Result := '';
  if Directory <> '' then
    Result := RemoveBackslashUnlessRoot(ExpandFileName(Directory));
end;

function SameInstallDirectory(const Left, Right: String): Boolean;
begin
  Result := (Left <> '') and (Right <> '') and
    (CompareText(NormalizedInstallDirectory(Left), NormalizedInstallDirectory(Right)) = 0);
end;

procedure UpdateLocationSummary(Sender: TObject);
var
  Target, Parent: String;
  Available, Total: Int64;
begin
  Target := RemoveBackslashUnlessRoot(WizardDirValue);
  WizardForm.SelectDirBrowseLabel.Caption := '';
  if SameInstallDirectory(Target, PreviousScopeDirectory) then
    WizardForm.SelectDirBrowseLabel.Caption := ScopeDescription + ' 将覆盖升级或重新安装现有 CodeBuddy，无需先卸载。';
  WizardForm.SelectDirBrowseLabel.Visible := WizardForm.SelectDirBrowseLabel.Caption <> '';
  while (Target <> '') and not DirExists(Target) do
  begin
    Parent := ExtractFileDir(Target);
    if Parent = Target then Break;
    Target := Parent;
  end;
  FreeSpaceLabel.Caption := '';
  if (Target <> '') and GetSpaceOnDisk64(Target, Available, Total) then
    FreeSpaceLabel.Caption := Format('可用空间：%.1f GB', [Available / 1073741824.0]);
end;

procedure InitializeLocationSummary;
var Key: String;
begin
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' +
    ExpandConstant('{#SetupSetting("AppId")}') + '_is1';
  if IsAdminInstallMode then begin
    RegQueryStringValue(HKLM64, Key, 'Inno Setup: App Path', PreviousScopeDirectory);
    RegQueryStringValue(HKCU64, Key, 'Inno Setup: App Path', OtherScopeDirectory);
  end else begin
    RegQueryStringValue(HKCU64, Key, 'Inno Setup: App Path', PreviousScopeDirectory);
    RegQueryStringValue(HKLM64, Key, 'Inno Setup: App Path', OtherScopeDirectory);
  end;
  if IsAdminInstallMode then ScopeDescription := '为此电脑上的所有用户安装。'
  else ScopeDescription := '仅为当前用户安装。';
  FreeSpaceLabel := TNewStaticText.Create(WizardForm);
  FreeSpaceLabel.Parent := WizardForm.SelectDirPage;
  FreeSpaceLabel.SetBounds(0, WizardForm.DiskSpaceLabel.Top + ScaleY(20), WizardForm.SelectDirPage.ClientWidth, ScaleY(20));
  FreeSpaceLabel.Font.Assign(WizardForm.DiskSpaceLabel.Font);
  WizardForm.DirEdit.OnChange := @UpdateLocationSummary;
  UpdateLocationSummary(WizardForm.DirEdit);
end;

function InstallerControlLeft(Control: TControl): Integer;
begin
  Result := Control.Left;
  while (Control.Parent <> nil) and (Control.Parent <> WizardForm) do
  begin
    Control := Control.Parent;
    Result := Result + Control.Left;
  end;
end;

procedure StyleInstallerButton(Button: TNewButton);
begin
  Button.Height := ScaleY(24);
  Button.Width := ScaleX(72);
  Button.Font.Name := 'Microsoft YaHei UI';
  Button.Font.Size := 9;
end;

procedure AlignInstallerFooter(CurPageID: Integer);
var
  ContentRight: Integer;
begin
  ContentRight := InstallerControlLeft(WizardForm.ProgressGauge) + WizardForm.ProgressGauge.Width;
  WizardForm.CancelButton.Left := ContentRight - WizardForm.CancelButton.Width;
  if CurPageID = wpFinished then
    WizardForm.NextButton.Left := ContentRight - WizardForm.NextButton.Width
  else
    WizardForm.NextButton.Left := WizardForm.CancelButton.Left - WizardForm.NextButton.Width - ScaleX(8);
  WizardForm.BackButton.Left := WizardForm.NextButton.Left - WizardForm.BackButton.Width - ScaleX(8);
end;

procedure InitializeInstallerUI;
var
  I, FinishLeft, FinishWidth: Integer;
  FolderGroup, FolderBorder: TPanel;
  FolderLabel: TNewStaticText;
begin
  WizardForm.Font.Name := 'Microsoft YaHei UI';
  WizardForm.Font.Size := 9;
  for I := 0 to WizardForm.ComponentCount - 1 do
  begin
    if WizardForm.Components[I] is TNewStaticText then TNewStaticText(WizardForm.Components[I]).Font.Assign(WizardForm.Font)
    else if WizardForm.Components[I] is TNewEdit then TNewEdit(WizardForm.Components[I]).Font.Assign(WizardForm.Font)
    else if WizardForm.Components[I] is TNewButton then TNewButton(WizardForm.Components[I]).Font.Assign(WizardForm.Font);
  end;
  WizardForm.Color := clBtnFace;
  WizardForm.InnerPage.Color := clBtnFace;
  WizardForm.MainPanel.Color := clWhite;
  WizardForm.PageNameLabel.Font.Size := 10;
  WizardForm.PageNameLabel.Font.Style := [fsBold];
  WizardForm.PageDescriptionLabel.Font.Color := $006B6763;
  WizardForm.PageDescriptionLabel.Font.Size := 9;
  WizardForm.PageNameLabel.Top := ScaleY(12);
  WizardForm.PageNameLabel.Height := ScaleY(24);
  WizardForm.PageDescriptionLabel.Top := ScaleY(36);
  WizardForm.WizardSmallBitmapImage.Width := ScaleX(40);
  WizardForm.WizardSmallBitmapImage.Height := ScaleY(40);
  WizardForm.WizardSmallBitmapImage.Top := ScaleY(12);
  WizardForm.WizardSmallBitmapImage.Left := WizardForm.MainPanel.ClientWidth - ScaleX(64);
  StyleInstallerButton(WizardForm.NextButton);
  StyleInstallerButton(WizardForm.BackButton);
  StyleInstallerButton(WizardForm.CancelButton);
  AlignInstallerFooter(wpSelectDir);
  WizardForm.CancelButton.Top := WizardForm.ClientHeight - ScaleY(34);
  WizardForm.NextButton.Top := WizardForm.CancelButton.Top;
  WizardForm.BackButton.Top := WizardForm.CancelButton.Top;

  WizardForm.SelectDirBitmapImage.Visible := False;
  WizardForm.SelectDirPage.Color := clBtnFace;
  WizardForm.SelectDirLabel.SetBounds(0, 0, WizardForm.SelectDirPage.ClientWidth, ScaleY(42));
  WizardForm.SelectDirLabel.Font.Size := 9;
  FolderBorder := TPanel.Create(WizardForm);
  FolderBorder.Parent := WizardForm.SelectDirPage;
  FolderBorder.Caption := '';
  FolderBorder.BevelOuter := bvNone;
  FolderBorder.ParentBackground := False;
  FolderBorder.Color := $00D8D8D8;
  FolderBorder.SetBounds(0, ScaleY(100), WizardForm.SelectDirPage.ClientWidth, ScaleY(56));
  FolderGroup := TPanel.Create(WizardForm);
  FolderGroup.Parent := FolderBorder;
  FolderGroup.Caption := '';
  FolderGroup.BevelOuter := bvNone;
  FolderGroup.ParentBackground := False;
  FolderGroup.Color := clBtnFace;
  FolderGroup.SetBounds(1, 1, FolderBorder.ClientWidth - 2, FolderBorder.ClientHeight - 2);
  FolderLabel := TNewStaticText.Create(WizardForm);
  FolderLabel.Parent := WizardForm.SelectDirPage;
  FolderLabel.SetBounds(ScaleX(8), FolderBorder.Top - ScaleY(8), ScaleX(68), ScaleY(20));
  FolderLabel.Color := clBtnFace;
  FolderLabel.Caption := '  安装目录  ';
  WizardForm.DirEdit.Parent := FolderGroup;
  WizardForm.DirBrowseButton.Parent := FolderGroup;
  WizardForm.DirEdit.SetBounds(ScaleX(12), ScaleY(22), FolderGroup.ClientWidth - ScaleX(112), ScaleY(24));
  WizardForm.DirEdit.Font.Size := 9;
  WizardForm.DirBrowseButton.SetBounds(FolderGroup.ClientWidth - ScaleX(84), ScaleY(22), ScaleX(72), WizardForm.DirEdit.Height);
  WizardForm.SelectDirBrowseLabel.SetBounds(0, ScaleY(48), WizardForm.SelectDirPage.ClientWidth, ScaleY(32));
  WizardForm.SelectDirBrowseLabel.Font.Color := $006B6763;
  WizardForm.DiskSpaceLabel.Top := FolderBorder.Top + FolderBorder.Height + ScaleY(14);
  WizardForm.DiskSpaceLabel.Font.Color := clWindowText;

  WizardForm.FilenameLabel.Visible := False;
  WizardForm.StatusLabel.SetBounds(0, ScaleY(18), WizardForm.InstallingPage.ClientWidth, ScaleY(22));
  WizardForm.StatusLabel.Caption := '正在准备应用文件…';
  WizardForm.StatusLabel.Font.Size := 9;
  WizardForm.StatusLabel.Font.Style := [];
  WizardForm.ProgressGauge.SetBounds(0, ScaleY(76), WizardForm.InstallingPage.ClientWidth, ScaleY(16));
  ProgressText := TNewStaticText.Create(WizardForm);
  ProgressText.Parent := WizardForm.InstallingPage;
  ProgressText.SetBounds(0, ScaleY(104), WizardForm.InstallingPage.ClientWidth, ScaleY(20));
  ProgressText.Font.Color := $006B6763;
  ProgressText.Caption := '0%';
  InitializeInstallDetails(ScaleY(40));

  WizardForm.WizardBitmapImage2.SetBounds(ScaleX(40), ScaleY(104), ScaleX(80), ScaleY(80));
  if WizardForm.WizardSmallBitmapImage.PngImage.Width > 0 then
    WizardForm.WizardBitmapImage2.PngImage.Assign(WizardForm.WizardSmallBitmapImage.PngImage)
  else
    WizardForm.WizardBitmapImage2.Bitmap.Assign(WizardForm.WizardSmallBitmapImage.Bitmap);
  WizardForm.WizardBitmapImage2.Stretch := True;
  WizardForm.WizardBitmapImage2.BackColor := clWhite;
  WizardForm.WizardBitmapImage2.Visible := True;
  FinishLeft := ScaleX(164);
  FinishWidth := WizardForm.FinishedPage.ClientWidth - FinishLeft - ScaleX(40);
  WizardForm.FinishedHeadingLabel.SetBounds(FinishLeft, ScaleY(28), FinishWidth, ScaleY(32));
  WizardForm.FinishedHeadingLabel.Font.Size := 12;
  WizardForm.FinishedHeadingLabel.Font.Style := [fsBold];
  WizardForm.FinishedLabel.SetBounds(FinishLeft, ScaleY(76), FinishWidth, ScaleY(44));
  WizardForm.FinishedLabel.WordWrap := True;
  WizardForm.FinishedLabel.Font.Color := $006B6763;
  DesktopShortcut := TNewCheckBox.Create(WizardForm);
  DesktopShortcut.Parent := WizardForm.FinishedPage;
  DesktopShortcut.Font.Assign(WizardForm.Font);
  DesktopShortcut.SetBounds(FinishLeft, ScaleY(136), FinishWidth, ScaleY(22));
  DesktopShortcut.Caption := '在桌面创建快捷方式';
  DesktopShortcut.Checked := True;
  StartMenuShortcut := TNewCheckBox.Create(WizardForm);
  StartMenuShortcut.Parent := WizardForm.FinishedPage;
  StartMenuShortcut.Font.Assign(WizardForm.Font);
  StartMenuShortcut.SetBounds(FinishLeft, ScaleY(166), FinishWidth, ScaleY(22));
  StartMenuShortcut.Caption := '添加到开始菜单';
  StartMenuShortcut.Checked := True;
  LaunchOnFinish := TNewCheckBox.Create(WizardForm);
  LaunchOnFinish.Parent := WizardForm.FinishedPage;
  LaunchOnFinish.Font.Assign(WizardForm.Font);
  LaunchOnFinish.SetBounds(FinishLeft, ScaleY(196), FinishWidth, ScaleY(22));
  LaunchOnFinish.Caption := '完成后打开 CodeBuddy';
  LaunchOnFinish.Checked := True;
  LaunchOnFinish.OnClick := @LaunchOnFinishClick;
end;
