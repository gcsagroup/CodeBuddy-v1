{ Check access with the installer's own token, without creating test files. }
function OpenInstallDirectory(Name: String; Access, Share: LongWord; Security: THandle;
  Disposition, Flags: LongWord; Template: THandle): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseInstallDirectory(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function InstallLocationProblem(const Target: String): String;
var
  Directory, Parent: String;
  Access: LongWord;
  Handle: THandle;
  ErrorCode: Integer;
begin
  Result := '';
  if Length(AddBackslash(Target)) + {#MaxRelativePath} > 259 then
  begin
    Result := '安装路径过长，请选择更短的位置，例如 D:\CodeBuddy。';
    Exit;
  end;
  Directory := RemoveBackslashUnlessRoot(ExpandFileName(Target));
  Access := $0006; { FILE_ADD_FILE and FILE_ADD_SUBDIRECTORY }
  while not DirExists(Directory) do
  begin
    Parent := ExtractFileDir(Directory);
    if FileExists(Directory) or (Parent = Directory) or (Parent = '') then
    begin
      Result := '无法使用此安装路径，请检查盘符和文件夹：' + Directory;
      Exit;
    end;
    Directory := Parent;
    Access := $0004; { Only need to create a directory in the existing parent. }
  end;
  Handle := OpenInstallDirectory(Directory, Access, 7, 0, 3, $02000000, 0);
  if Handle <> THandle(-1) then
  begin
    CloseInstallDirectory(Handle);
    Exit;
  end;
  ErrorCode := DLLGetLastError;
  if ErrorCode = 5 then
    Result := '当前账户没有写入此安装位置的权限。请选择默认位置 ' +
      ExpandConstant('{localappdata}\Programs\CodeBuddy') + '，或联系管理员。'
  else
    Result := '无法访问安装位置 ' + Directory + '。' + SysErrorMessage(ErrorCode);
end;
