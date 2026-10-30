{ Read-only process inspection. Never terminate the app or its workers. }
function RunningCodeBuddyMessageForDirectory(const Directory: String): String;
var
  Locator, Service, Processes, Process: Variant;
  I: Integer;
  Executable, Name, AppRoot, Pattern: String;
begin
  Result := '';
  AppRoot := AddBackslash(ExpandFileName(Directory));
  { Filter in WMI before crossing the COM boundary for each candidate.
    Escape LIKE metacharacters so an install path remains a literal prefix. }
  Pattern := AppRoot;
  StringChangeEx(Pattern, '\', '\\', True);
  StringChangeEx(Pattern, '[', '[[]', True);
  StringChangeEx(Pattern, '%', '[%]', True);
  StringChangeEx(Pattern, '_', '[_]', True);
  try
    Log('Checking running CodeBuddy processes');
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Service.ExecQuery('SELECT Name, ExecutablePath FROM Win32_Process WHERE Name = "CodeBuddy.exe" OR ExecutablePath LIKE "' + Pattern + '%"');
    for I := 0 to Processes.Count - 1 do
    begin
      Process := Processes.ItemIndex(I);
      Name := Process.Name;
      Executable := '';
      if not VarIsNull(Process.ExecutablePath) then Executable := Process.ExecutablePath;
      { Includes other installed CodeBuddy versions and this installation's workers.
        Uninstall executables are deliberately excluded from the directory match. }
      if (CompareText(Name, 'CodeBuddy.exe') = 0) or
         ((Executable <> '') and
          (CompareText(Copy(Executable, 1, Length(AppRoot)), AppRoot) = 0) and
          (CompareText(Copy(Name, 1, 5), 'unins') <> 0)) then
      begin
        Result := 'CodeBuddy 或其后台进程仍在运行（' + Name + '）。请保存工作并退出 CodeBuddy，等待后台任务停止后再继续。安装程序不会强制结束进程。';
        Exit;
      end;
    end;
    Log('Finished checking running CodeBuddy processes');
  except
    Result := '无法检查 CodeBuddy 进程，请确认系统进程查询服务可用后重试。为保护正在运行的任务，本次操作未继续。';
    Log(GetExceptionMessage);
  end;
end;

function RunningCodeBuddyMessage: String;
begin
  Result := RunningCodeBuddyMessageForDirectory(ExpandConstant('{app}'));
end;
