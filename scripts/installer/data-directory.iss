{ Installation never selects or migrates data. Runtime owns the default and locator. }
#ifndef StorageLocator
  #define StorageLocator "{userappdata}\CodeBuddy\data-root.txt"
#endif

function StorageLocationFile: String;
begin
  Result := ExpandConstant('{#StorageLocator}');
end;

function ReadStorageLocation: String;
var
  Raw: AnsiString;
begin
  Result := ExpandConstant('{%USERPROFILE}\.CodeBuddy');
  if FileExists(StorageLocationFile) then
  begin
    if not LoadStringFromFile(StorageLocationFile, Raw) then
      RaiseException('无法读取现有数据目录位置，请检查文件权限后重试。');
    Result := Trim(UTF8Decode(Raw));
    if (Length(Result) > 0) and (Result[1] = #$FEFF) then Delete(Result, 1, 1);
  end;
end;

function DataPathsOverlap(const First, Second: String): Boolean;
var
  A, B: String;
begin
  A := AddBackslash(ExpandFileName(First));
  B := AddBackslash(ExpandFileName(Second));
  Result := (CompareText(Copy(A, 1, Length(B)), B) = 0) or
    (CompareText(Copy(B, 1, Length(A)), A) = 0);
end;

function ValidateDataDirectory: String;
var
  Value: String;
begin
  Result := '';
  Value := ReadStorageLocation;
  if (Length(Value) < 4) or (Copy(Value, 2, 2) <> ':\') then
    Result := '已保存的数据目录位置无效，请检查数据位置记录后重试。'
  else if DataPathsOverlap(Value, WizardDirValue) or
          DataPathsOverlap(ExtractFileDir(StorageLocationFile), WizardDirValue) then
    Result := '程序和用户数据需要分开保存，请更换程序安装位置。';
end;
