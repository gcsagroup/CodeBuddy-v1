{ Inno owns progress and its diagnostic log; show only the current component. }
#include "component-labels.iss"
var
  InstallItemLabel: TNewStaticText;
  InstalledFileIndex: TStringList;
  DetailsComponent: String;

procedure RecordInstallDetail(const Detail: String);
begin
  Log(Detail);
  InstallItemLabel.Caption := Detail;
end;

procedure ShowInstallingFile;
var
  FilePath, AppPrefix, Component: String;
begin
  FilePath := ExpandConstant(CurrentFilename);
  AppPrefix := AddBackslash(ExpandConstant('{app}'));
  if CompareText(Copy(FilePath, 1, Length(AppPrefix)), AppPrefix) = 0 then
  begin
    Delete(FilePath, 1, Length(AppPrefix));
    InstalledFileIndex.Add(FilePath);
  end;
  Component := InstallationComponent(FilePath);
  InstallItemLabel.Caption := Component;
  if Component <> DetailsComponent then
  begin
    Log('正在准备 · ' + Component);
    DetailsComponent := Component;
  end;
end;

procedure InitializeInstallDetails(Top: Integer);
begin
  InstalledFileIndex := TStringList.Create;
  InstalledFileIndex.Sorted := True;
  InstalledFileIndex.Duplicates := dupIgnore;
  InstallItemLabel := TNewStaticText.Create(WizardForm);
  InstallItemLabel.Parent := WizardForm.InstallingPage;
  InstallItemLabel.SetBounds(WizardForm.ProgressGauge.Left, Top, WizardForm.ProgressGauge.Width, ScaleY(20));
  InstallItemLabel.Font.Assign(WizardForm.Font);
  InstallItemLabel.Font.Color := $006B6763;
  InstallItemLabel.Caption := '应用文件';
end;
