{ Silent uninstall always preserves data. Cleanup requires an interactive choice. }
var
  CleanupMode: String;
  CleanupRoot: String;

function DataOption(Form: TSetupForm; Y: Integer; const Caption: String): TNewRadioButton;
begin
  Result := TNewRadioButton.Create(Form);
  Result.Parent := Form;
  Result.SetBounds(ScaleX(24), ScaleY(Y), ScaleX(472), ScaleY(25));
  Result.Caption := Caption;
end;

function InitializeUninstall: Boolean;
var
  Form: TSetupForm;
  Description: TNewStaticText;
  KeepData, HistoryOnly, AllData: TNewRadioButton;
  ConfirmButton, CancelButton: TNewButton;
  Root, Problem, Confirmation: String;
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
    Description.SetBounds(ScaleX(24), ScaleY(24), ScaleX(472), ScaleY(92));
    Description.AutoSize := False;
    Description.WordWrap := True;
    Description.Caption := '卸载时如何处理个人数据？工作区和已登记项目将保留。' + #13#10#13#10;
    if Root <> '' then Description.Caption := Description.Caption + '数据目录：' + Root
    else Description.Caption := Description.Caption + '无法读取数据位置，仅可卸载程序。';
    KeepData := DataOption(Form, 118, '保留个人数据（重装后可继续使用）');
    HistoryOnly := DataOption(Form, 151, '仅清理聊天历史，保留模型配置和其他设置');
    AllData := DataOption(Form, 184, '清理个人数据，包括聊天、配置、凭据记录、宠物和日志');
    KeepData.Checked := True;
    HistoryOnly.Enabled := Root <> '';
    AllData.Enabled := Root <> '';
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
    if HistoryOnly.Checked then
    begin
      CleanupMode := 'history';
      Confirmation := '永久清理当前数据目录中的聊天历史？模型配置、项目文件、诊断日志和单独导出的副本将保留。';
    end
    else if AllData.Checked then
    begin
      CleanupMode := 'clean';
      Confirmation := '永久清理个人数据？工作区及已登记项目将保留。';
    end;
  finally
    Form.Free;
  end;
  if CleanupMode <> '' then
    if MsgBox(Confirmation + #13#10#13#10 + Root + #13#10 + '此操作不可恢复。',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then Exit;
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
  if CleanupMode <> '' then
  begin
    Node := ExpandConstant('{app}\resources\harness-distribution\node\node.exe');
    Helper := ExpandConstant('{app}\resources\harness-distribution\runtime\windows-uninstall.cjs');
    Report := ExpandConstant('{userappdata}\CodeBuddy\uninstall-cleanup.json');
    if not ForceDirectories(ExtractFileDir(Report)) then
    begin
      MsgBox('无法创建卸载清理报告目录，卸载已停止。', mbError, MB_OK);
      Abort;
    end;
    if not Exec(Node, '"' + Helper + '" ' + CleanupMode + ' "' + CleanupRoot + '" "' +
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
    Log('已完成用户选择的数据清理：' + CleanupMode);
  end;
end;
