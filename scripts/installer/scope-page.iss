var
  ScopePage: TWizardPage;
  Machine, Personal: TNewRadioButton;
  StatusText: TNewStaticText;
  PreviousMachine, PreviousUser: String;
  FixedScope, HandoffComplete, MachineRequested, EnginePrepared: Boolean;
  PrepareTimer: UINT_PTR;

function SetPrepareTimer(Wnd: HWND; Id: UINT_PTR; Delay: UINT; Callback: LongWord): UINT_PTR;
  external 'SetTimer@user32.dll stdcall';
function KillPrepareTimer(Wnd: HWND; Id: UINT_PTR): Boolean;
  external 'KillTimer@user32.dll stdcall';

procedure StopPrepareTimer;
begin
  if PrepareTimer <> 0 then begin
    KillPrepareTimer(0, PrepareTimer);
    PrepareTimer := 0;
  end;
end;

procedure UpdateScopeShield(PageID: Integer);
begin
  SendMessage(WizardForm.NextButton.Handle, $160C, 0,
    Ord((PageID = ScopePage.ID) and Machine.Checked and not IsAdmin));
end;

procedure ScopeChanged(Sender: TObject);
var Existing: String;
begin
  if Machine.Checked then Existing := PreviousMachine else Existing := PreviousUser;
  if Existing <> '' then StatusText.Caption := '已安装在 ' + Existing + '，将更新此版本。'
  else if Machine.Checked then StatusText.Caption := '为所有用户安装需要管理员权限。'
  else StatusText.Caption := '只有当前 Windows 用户可以使用此安装。';
  UpdateScopeShield(WizardForm.CurPageID);
end;

function AddChoice(Y: Integer; const Caption: String): TNewRadioButton;
begin
  Result := TNewRadioButton.Create(WizardForm);
  Result.Parent := ScopePage.Surface;
  Result.SetBounds(ScaleX(12), ScaleY(Y), ScopePage.SurfaceWidth - ScaleX(16), ScaleY(24));
  Result.Caption := Caption;
end;

procedure InitializeScopePage;
var
  I: Integer;
  Key: String;
  Intro: TNewStaticText;
begin
  FixedScope := WizardSilent;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/ALLUSERS') = 0 then begin FixedScope := True; MachineRequested := True; end
    else if CompareText(ParamStr(I), '/CURRENTUSER') = 0 then begin FixedScope := True; MachineRequested := False; end;
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + '{#ProductUninstallId}' + '_is1';
  RegQueryStringValue(HKCU64, Key, 'Inno Setup: App Path', PreviousUser);
  RegQueryStringValue(HKLM64, Key, 'Inno Setup: App Path', PreviousMachine);
  ScopePage := CreateCustomPage(wpWelcome, '安装选项', '为哪位用户安装 CodeBuddy？');
  WizardForm.InnerPage.Color := clBtnFace;
  ScopePage.Surface.Color := clBtnFace;
  WizardForm.MainPanel.Color := clWhite;
  WizardForm.WizardSmallBitmapImage.SetBounds(WizardForm.MainPanel.ClientWidth - ScaleX(64),
    ScaleY(12), ScaleX(40), ScaleY(40));
  Intro := TNewStaticText.Create(WizardForm);
  Intro.Parent := ScopePage.Surface;
  Intro.Caption := '请选择为当前用户还是所有用户安装该软件。';
  Machine := AddChoice(50, '为使用这台电脑的任何人安装（所有用户）');
  Personal := AddChoice(82, '仅为我安装（' + GetUserNameString + '）');
  StatusText := TNewStaticText.Create(WizardForm);
  StatusText.Parent := ScopePage.Surface;
  StatusText.AutoSize := False;
  StatusText.WordWrap := True;
  StatusText.SetBounds(0, ScopePage.SurfaceHeight - ScaleY(56), ScopePage.SurfaceWidth, ScaleY(56));
  WizardForm.BeveledLabel.Caption := 'CodeBuddy {#AppVersion}';
  WizardForm.BeveledLabel.Visible := True;
  Personal.OnClick := @ScopeChanged;
  Machine.OnClick := @ScopeChanged;
  if MachineRequested then Machine.Checked := True else Personal.Checked := True;
  ScopeChanged(nil);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ScopePage.ID) and FixedScope;
end;

#ifdef BundledData
procedure PrepareApplicationData(Wnd: HWND; Msg: UINT; Id: UINT_PTR; Time: DWORD);
var
  Temp: String;
begin
  StopPrepareTimer;
  Temp := AddBackslash(ExpandConstant('{tmp}'));
  try
    ExtractTemporaryFile('application.part');
    if not RenameFile(Temp + 'application.part', Temp + 'CodeBuddy-Install-1.bin') then
      RaiseException('无法完成安装文件的准备。');
    Log('Application data ready');
  except
    Log('Application data preparation failed: ' + GetExceptionMessage);
    SaveStringToFile(Temp + 'prepare.failed', '1', False);
  end;
end;
#endif

function RunInstaller: Integer;
var
  ExitCode: Integer;
  I: Integer;
  Params, Arg, Upper: String;
begin
  { The native loader requests UAC and retains the original user for postinstall launch. }
  if Machine.Checked then Params := '/ALLUSERS' else Params := '/CURRENTUSER';
  for I := 1 to ParamCount do begin
    Arg := ParamStr(I);
    Upper := Uppercase(Arg);
    { Internal loader handles and offsets belong only to the original invocation. }
    if (Upper = '/ALLUSERS') or (Upper = '/CURRENTUSER') then Continue;
    if Pos('/LOG=', Upper) = 1 then Arg := Arg + '.install.log';
    if (Copy(Upper, 1, 3) <> '/SL') and (Copy(Upper, 1, 6) <> '/SPAWN') and
       (Pos('/NOTIFYWND=', Upper) <> 1) and (Pos('/DEBUGWND=', Upper) <> 1) then
      Params := Params + ' ' + AddQuotes(Arg);
  end;
  StopPrepareTimer;
  if not FixedScope then
    Params := Params + ' /WIZARDX=' + IntToStr(WizardForm.Left) + ' /WIZARDY=' + IntToStr(WizardForm.Top);
  StatusText.Caption := '正在准备安装…';
  WizardForm.NextButton.Enabled := False;
  WizardForm.Repaint;
  try
    if not EnginePrepared then begin
      ExtractTemporaryFile('CodeBuddy-Install.exe');
      EnginePrepared := True;
    end;
    WizardForm.Hide;
#ifdef BundledData
    { Exec pumps this hidden window's messages while the native child owns
      the visible UI and UAC. Publish the slice only after extraction succeeds. }
    if not FileExists(ExpandConstant('{tmp}\CodeBuddy-Install-1.bin')) then begin
      DeleteFile(ExpandConstant('{tmp}\prepare.failed'));
      PrepareTimer := SetPrepareTimer(0, 0, 50, CreateCallback(@PrepareApplicationData));
      if PrepareTimer = 0 then RaiseException('无法开始准备安装文件。');
    end;
#endif
    Log('Starting installation: ' + Copy(Params, 1, Pos(' ', Params + ' ') - 1));
    if Exec(ExpandConstant('{tmp}\CodeBuddy-Install.exe'), Params, ExpandConstant('{src}'),
      SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode) then begin
      Result := ExitCode;
      if Result <> 0 then
        StatusText.Caption := '安装未完成，可重试或更改安装范围。（退出码 ' + IntToStr(Result) + '）';
    end else begin
      Result := ExitCode;
      StatusText.Caption := '无法打开安装程序：' + SysErrorMessage(ExitCode);
    end;
  except
    Result := 1;
    StatusText.Caption := '无法准备安装程序：' + GetExceptionMessage;
  end;
  StopPrepareTimer;
  Log('Installation result: ' + IntToStr(Result) + ' ' + StatusText.Caption);
  if (Result <> 0) and not FixedScope then WizardForm.Show;
  WizardForm.NextButton.Enabled := True;
end;
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if HandoffComplete then begin Cancel := True; Confirm := False; end;
end;

procedure DeinitializeSetup;
begin
  StopPrepareTimer;
end;
