{ Observe only installer-owned files. Inno remains the deletion owner. }
#include "component-labels.iss"
var
  UninstallPendingFiles: TStringList;
  UninstallDetailsTimer: UINT_PTR;
  UninstallRemovedFiles: Integer;
  UninstallScanPosition: Integer;
  UninstallFileText: TNewStaticText;
  UninstallDetailsUIActive: Boolean;
  UninstallDetailsComponent: String;

function SetUninstallDetailsTimer(hWnd: HWND; nIDEvent: UINT_PTR; uElapse: UINT; lpTimerFunc: Longword): UINT_PTR;
  external 'SetTimer@user32.dll stdcall';
function KillUninstallDetailsTimer(hWnd: HWND; uIDEvent: UINT_PTR): Boolean;
  external 'KillTimer@user32.dll stdcall';

procedure ObserveUninstallFiles(CompleteScan: Boolean);
var
  Remaining: Integer;
  RelativeName, Component: String;
begin
  Remaining := 1000;
  if CompleteScan then Remaining := UninstallPendingFiles.Count;
  while (Remaining > 0) and (UninstallPendingFiles.Count > 0) do
  begin
    if UninstallScanPosition >= UninstallPendingFiles.Count then UninstallScanPosition := 0;
    RelativeName := UninstallPendingFiles[UninstallScanPosition];
    if not FileExists(AddBackslash(ExpandConstant('{app}')) + RelativeName) then
    begin
      Component := InstallationComponent(RelativeName);
      if Component <> UninstallDetailsComponent then
      begin
        Log('已移除 · ' + Component);
        UninstallDetailsComponent := Component;
      end;
      UninstallPendingFiles.Delete(UninstallScanPosition);
      Inc(UninstallRemovedFiles);
      if UninstallDetailsUIActive then UninstallFileText.Caption := Component;
    end
    else Inc(UninstallScanPosition);
    Dec(Remaining);
  end;
end;

procedure UninstallDetailsTick(Wnd: HWND; Msg: UINT; TimerID: UINT_PTR; Time: DWORD);
begin
  ObserveUninstallFiles(False);
end;

function UninstallControlLeft(Control: TControl): Integer;
begin
  Result := Control.Left;
  while (Control.Parent <> nil) and (Control.Parent <> UninstallProgressForm) do
  begin
    Control := Control.Parent;
    Result := Result + Control.Left;
  end;
end;

procedure InitializeUninstallDetails;
var
  Entries: TArrayOfString;
  I, ExtraHeight, ContentInset, ContentWidth: Integer;
  Root, FullName, RelativeName: String;
begin
  UninstallDetailsUIActive := True;
  Root := AddBackslash(ExpandConstant('{app}'));
  UninstallProgressForm.Font.Name := 'Microsoft YaHei UI';
  UninstallProgressForm.Font.Size := 9;
  for I := 0 to UninstallProgressForm.ComponentCount - 1 do
    if UninstallProgressForm.Components[I] is TNewStaticText then
      TNewStaticText(UninstallProgressForm.Components[I]).Font.Assign(UninstallProgressForm.Font);
  UninstallProgressForm.Color := clBtnFace;
  UninstallProgressForm.MainPanel.Color := clWhite;
  UninstallProgressForm.PageNameLabel.Caption := '正在卸载 CodeBuddy';
  UninstallProgressForm.PageNameLabel.Font.Size := 10;
  UninstallProgressForm.PageNameLabel.Font.Style := [fsBold];
  UninstallProgressForm.PageNameLabel.Top := ScaleY(12);
  UninstallProgressForm.PageNameLabel.Height := ScaleY(24);
  UninstallProgressForm.PageDescriptionLabel.Caption := '正在移除程序文件。用户数据和项目将保留。';
  UninstallProgressForm.PageDescriptionLabel.Top := ScaleY(36);
  UninstallProgressForm.PageDescriptionLabel.Font.Color := $006B6763;
  UninstallProgressForm.ClientWidth := ScaleX(500);
  if FileExists(Root + 'resources\installer-logo.png') then
  begin
    try
      UninstallProgressForm.WizardSmallBitmapImage.PngImage.LoadFromFile(Root + 'resources\installer-logo.png');
    except
      Log('卸载标识读取失败，使用系统默认标识。');
    end;
  end;
  UninstallProgressForm.WizardSmallBitmapImage.SetBounds(
    UninstallProgressForm.MainPanel.ClientWidth - ScaleX(64), ScaleY(12), ScaleX(40), ScaleY(40));
  UninstallProgressForm.WizardSmallBitmapImage.Stretch := True;

  UninstallPendingFiles := TStringList.Create;
  UninstallPendingFiles.Sorted := True;
  UninstallPendingFiles.Duplicates := dupIgnore;
  { Ignore malformed and out-of-root entries; this is never a delete list. }
  if LoadStringsFromFile(Root + 'resources\installed-files.txt', Entries) then
    for I := 0 to GetArrayLength(Entries) - 1 do
    begin
      RelativeName := Entries[I];
      FullName := ExpandFileName(Root + RelativeName);
      if (RelativeName <> '') and
         (CompareText(Copy(FullName, 1, Length(Root)), Root) = 0) and
         FileExists(FullName) then UninstallPendingFiles.Add(Copy(FullName, Length(Root) + 1, MaxInt));
    end;

  ExtraHeight := ScaleY(360) - UninstallProgressForm.ClientHeight;
  if ExtraHeight > 0 then
  begin
    UninstallProgressForm.ClientHeight := UninstallProgressForm.ClientHeight + ExtraHeight;
    UninstallProgressForm.OuterNotebook.Height := UninstallProgressForm.OuterNotebook.Height + ExtraHeight;
    UninstallProgressForm.InnerNotebook.Height := UninstallProgressForm.InnerNotebook.Height + ExtraHeight;
  end;
  ContentInset := ScaleX(36);
  ContentWidth := UninstallProgressForm.InstallingPage.ClientWidth - 2 * ContentInset;
  UninstallProgressForm.StatusLabel.SetBounds(ContentInset, ScaleY(18), ContentWidth, ScaleY(22));
  UninstallProgressForm.ProgressBar.SetBounds(ContentInset, ScaleY(76), ContentWidth, ScaleY(16));
  UninstallFileText := TNewStaticText.Create(UninstallProgressForm);
  UninstallFileText.Parent := UninstallProgressForm.InstallingPage;
  UninstallFileText.SetBounds(ContentInset, ScaleY(40), ContentWidth, ScaleY(20));
  UninstallFileText.Font.Assign(UninstallProgressForm.Font);
  UninstallFileText.Font.Color := $006B6763;
  UninstallFileText.Caption := '应用文件';
  UninstallProgressForm.CancelButton.Font.Assign(UninstallProgressForm.Font);
  UninstallProgressForm.CancelButton.SetBounds(
    UninstallControlLeft(UninstallProgressForm.ProgressBar) + UninstallProgressForm.ProgressBar.Width - ScaleX(72),
    UninstallProgressForm.ClientHeight - ScaleY(34), ScaleX(72), ScaleY(24));
  UninstallProgressForm.Bevel.Top := UninstallProgressForm.CancelButton.Top - ScaleY(12);
  Log('开始卸载 CodeBuddy；保留用户数据、聊天和项目。');
  UninstallDetailsTimer := SetUninstallDetailsTimer(0, 0, 100, CreateCallback(@UninstallDetailsTick));
end;

procedure FinishUninstallDetails;
begin
  { Inno destroys the progress form before usPostUninstall. }
  UninstallDetailsUIActive := False;
  if UninstallDetailsTimer <> 0 then
  begin
    KillUninstallDetailsTimer(0, UninstallDetailsTimer);
    UninstallDetailsTimer := 0;
  end;
  ObserveUninstallFiles(True);
  Log('程序文件卸载处理结束；已观察到删除 ' + IntToStr(UninstallRemovedFiles) + ' 个文件。用户数据和项目保留。');
end;

procedure InitializeUninstallProgressForm;
begin
  InitializeUninstallDetails;
end;

procedure DeinitializeUninstall;
begin
  if UninstallDetailsTimer <> 0 then KillUninstallDetailsTimer(0, UninstallDetailsTimer);
  UninstallDetailsTimer := 0;
end;
