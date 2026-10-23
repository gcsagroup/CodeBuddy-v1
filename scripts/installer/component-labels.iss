#ifndef CodeBuddyComponentLabels
#define CodeBuddyComponentLabels
{ Presentation only: the native installer remains the source of progress. }
function InstallationComponent(const RelativePath: String): String;
var
  Value: String;
begin
  Value := Lowercase(RelativePath);
  if Pos('resources\harness-distribution\runtime\py\', Value) = 1 then Result := '文档处理组件'
  else if Pos('resources\harness-distribution\runtime\harness\', Value) = 1 then Result := '智能助手组件'
  else if Pos('resources\harness-distribution\runtime\tools\', Value) = 1 then Result := '内置工具'
  else if Pos('resources\harness-distribution\node\', Value) = 1 then Result := '运行环境'
  else if Pos('resources\harness-distribution\', Value) = 1 then Result := '应用组件'
  else if (Pos('licenses\', Value) = 1) or (Value = 'license.txt') then Result := '许可信息'
  else Result := '应用界面';
end;
#endif
