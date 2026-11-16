; The outer wizard stays at the caller's privilege level. Only the inner Inno
; installer decides whether Windows needs to elevate, based on /ALLUSERS.
#ifndef ProductUninstallId
#define ProductUninstallId "{57246561-8F37-48B1-9DE6-2878918A3EBA}"
#endif
[Setup]
AppId=CodeBuddyScopeLauncher
AppName=CodeBuddy
AppVersion={#AppVersion}
VersionInfoDescription=CodeBuddy 安装程序
CreateAppDir=no
CreateUninstallRegKey=no
Uninstallable=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
DisableProgramGroupPage=yes
UsePreviousLanguage=no
SetupIconFile={#ProductIcon}
WizardSmallImageFile={#ProductImage}
WizardImageFile=
WizardStyle=modern light
WizardSizePercent=100,100
OutputDir={#OutputDir}
OutputBaseFilename=CodeBuddy-Setup
Compression=none
CloseApplications=no
RestartApplications=no

[Languages]
Name: "zhCN"; MessagesFile: "{#ChineseMessages}"

[LangOptions]
DialogFontName=Microsoft YaHei UI
DialogFontSize=9

[Messages]
SetupWindowTitle=CodeBuddy 安装
ButtonInstall=安装(&I)
WizardInstalling=正在准备安装
InstallingLabel=正在准备 CodeBuddy 安装文件，请稍候。

[Files]
Source: "{#InnerSetup}"; DestName: "CodeBuddy-Install.exe"; Flags: dontcopy noencryption
#ifdef BundledData
Source: "{#BundledData}"; DestName: "application.part"; Flags: dontcopy noencryption
#endif

[Code]
var InnerResult: Integer;

#include "scope-page.iss"

procedure InitializeWizard;
begin
  InitializeScopePage;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  UpdateScopeShield(CurPageID);
  if CurPageID = ScopePage.ID then begin
    WizardForm.NextButton.Caption := SetupMessage(msgButtonNext);
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ScopePage.ID) and not FixedScope then begin
    InnerResult := RunInstaller;
    HandoffComplete := InnerResult = 0;
    Result := HandoffComplete;
  end;
end;

procedure CurStepChanged(Step: TSetupStep);
begin
  if (Step = ssPostInstall) and FixedScope then InnerResult := RunInstaller;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := InnerResult;
end;
