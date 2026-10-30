{ Silent uninstall always preserves data. Cleanup requires an interactive choice. }
var
  CleanupRequested: Boolean;
  CleanupRoot: String;

function InitializeUninstall: Boolean;
var
  Form: TSetupForm;
  Description: TNewStaticText;
  CleanData: TNewCheckBox;
  ConfirmButton, CancelButton: TNewButton;
  Root, Problem: String;
  Clean: Boolean;
begin
  Result := False;
  Problem := RunningCodeBuddyMessage;
  if Problem <> '' then
  begin
    if not UninstallSilent then MsgBox(Problem, mbError, MB_OK);
    Log(Problem);
    Exit;
  end;
  if UninstallSilent then
  begin
    Result := True;
    Exit;
  end;
  try
    Root := ReadStorageLocation;
  except
    { A broken locator must not prevent an application-only uninstall. }
    Root := '';
    Log(GetExceptionMessage);
  end;
  Form := CreateCustomForm(520, 300, False, False);
  try
    Form.Caption := '卸载 CodeBuddy';
    Form.Position := poScreenCenter;
    Description := TNewStaticText.Create(Form);
    Description.Parent := Form;
    Description.SetBounds(ScaleX(24), ScaleY(24), ScaleX(472), ScaleY(140));
    Description.AutoSize := False;
    Description.WordWrap := True;
    Description.Caption := '将移除 CodeBuddy 程序。默认保留个人数据，重装后可继续使用。' + #13#10#13#10 +
      '勾选后将永久清理配置、凭据记录、聊天、宠物、日志和缓存。工作区及已登记项目保留。其他位置的历史数据不清理。' + #13#10#13#10 + '数据目录：' + Root;
    CleanData := TNewCheckBox.Create(Form);
    CleanData.Parent := Form;
    CleanData.SetBounds(ScaleX(24), ScaleY(174), ScaleX(472), ScaleY(26));
    CleanData.Caption := '同时清理上述个人数据（不可恢复，保留项目）';
    CleanData.Checked := False;
    CleanData.Enabled := Root <> '';
    ConfirmButton := TNewButton.Create(Form);
    ConfirmButton.Parent := Form;
    ConfirmButton.SetBounds(ScaleX(300), ScaleY(246), ScaleX(92), ScaleY(30));
    ConfirmButton.Caption := '卸载';
    ConfirmButton.ModalResult := mrOk;
    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.SetBounds(ScaleX(404), ScaleY(246), ScaleX(92), ScaleY(30));
    CancelButton.Caption := '取消';
    CancelButton.Cancel := True;
    CancelButton.Default := True;
    CancelButton.ModalResult := mrCancel;
    if Form.ShowModal <> mrOk then Exit;
    Clean := CleanData.Checked;
  finally
    Form.Free;
  end;
  if Clean and (MsgBox('确认永久清理个人数据？' + #13#10 + Root + #13#10 +
    '此操作不可恢复；工作区及已登记项目将保留。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES) then Exit;
  CleanupRequested := Clean;
  CleanupRoot := Root;
  Result := True;
end;

{ Runs only after Inno's own final confirmation, before deleting program files. }
procedure PrepareUninstallData;
var
  Problem, Node, Helper, Report: String;
  ExitCode: Integer;
begin
  Problem := RunningCodeBuddyMessage;
  if Problem <> '' then
  begin
    if not UninstallSilent then MsgBox(Problem, mbError, MB_OK);
    Log(Problem);
    Abort;
  end;
  if CleanupRequested then
  begin
    Node := ExpandConstant('{app}\resources\harness-distribution\node\node.exe');
    Helper := ExpandConstant('{app}\resources\harness-distribution\runtime\windows-uninstall.cjs');
    Report := ExpandConstant('{userappdata}\CodeBuddy\uninstall-cleanup.json');
    if not ForceDirectories(ExtractFileDir(Report)) then
    begin
      MsgBox('无法创建卸载清理报告目录，卸载已停止。', mbError, MB_OK);
      Abort;
    end;
    if not Exec(Node, '"' + Helper + '" clean "' + CleanupRoot + '" "' +
      ExpandConstant('{app}') + '" "' + Report + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    begin
      MsgBox('无法启动数据清理程序，卸载已取消，程序文件保留。', mbError, MB_OK);
      Abort;
    end;
    if ExitCode <> 0 then
    begin
      MsgBox('数据清理未全部完成，卸载已停止，程序文件保留。请查看报告：' + #13#10 + Report, mbError, MB_OK);
      Abort;
    end;
    Log('已按用户确认清理个人数据，工作区及已登记项目保留。');
  end;
end;
