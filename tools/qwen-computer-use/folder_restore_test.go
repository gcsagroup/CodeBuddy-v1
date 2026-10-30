package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFolderRestoreMatchesAddressNotTitle(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bridge")
	}
	file := filepath.Join(t.TempDir(), "runtime.ps1")
	if err := os.WriteFile(file, []byte(windowsRuntimeScript), 0600); err != nil {
		t.Fatal(err)
	}
	script := `$ErrorActionPreference='Stop';
Add-Type 'public static class OcuDesktop { public static long Raised; public static bool Fail; public static void Raise(System.IntPtr h){ if(Fail)throw new System.Exception("activation denied"); Raised=h.ToInt64(); } }';
$ast=[System.Management.Automation.Language.Parser]::ParseFile('` + strings.ReplaceAll(file, "'", "''") + `',[ref]$null,[ref]$null);
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Restore-OpenFolder'},$true)|ForEach-Object {Invoke-Expression $_.Extent.Text};
$wrong=[pscustomobject]@{LocationURL='file:///D:/other/same';HWND=11;Visible=$false};
$invalid=[pscustomobject]@{LocationURL='not a URL';HWND=12;Visible=$false};
$web=[pscustomobject]@{LocationURL='https://example.com/same';HWND=13;Visible=$false};
$right=[pscustomobject]@{LocationURL='file:///D:/target/same%20%5B1%5D%20%26%20%24';HWND=14;Visible=$false};
$fixtureShell=[pscustomobject]@{};$fixtureShell|Add-Member ScriptMethod Windows {return @($wrong,$invalid,$web,$right)};
function New-Object {param($ComObject) if($ComObject -ne 'Shell.Application'){throw 'Unexpected component'};return $fixtureShell};
if(Restore-OpenFolder 'D:\missing\same'){throw 'Missing directory restored'};
if([OcuDesktop]::Raised -ne 0){throw 'Unrelated window raised'};
if(-not (Restore-OpenFolder 'D:\target\same [1] & $')){throw 'Encoded path not matched'};
if([OcuDesktop]::Raised -ne 14 -or -not $right.Visible -or $wrong.Visible -or $invalid.Visible -or $web.Visible){throw 'Wrong window restored'};
if(-not (Restore-OpenFolder 'd:\target\same [1] & $\')){throw 'Repeated/case/trailing-separator restore failed'};
[OcuDesktop]::Fail=$true;$denied=$false;
try {Restore-OpenFolder 'D:\target\same [1] & $'|Out-Null}catch{$denied=$true};
if(-not $denied){throw 'Activation failure hidden as a fresh launch'};
'missing;encoded;exact-parent;repeat;denied'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "missing;encoded;exact-parent;repeat;denied" {
		t.Fatalf("folder restore: %v: %s", err, out)
	}
}

func TestFocusEvidenceDoesNotCrossWindowsInOneProcess(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bridge")
	}
	file := filepath.Join(t.TempDir(), "runtime.ps1")
	if err := os.WriteFile(file, []byte(windowsRuntimeScript), 0600); err != nil {
		t.Fatal(err)
	}
	script := `$ErrorActionPreference='Stop';
Add-Type 'public static class OcuDesktop { public static bool IsForeground(System.IntPtr h){return h.ToInt64()==11;} } namespace Windows.Automation { public class Info {public int ProcessId=7;public string LocalizedControlType="Edit";public string Name="Draft";} public class Range {public string GetText(int n){return "selected draft";}} public class Ranges {public int Count=1;public Range Item(int i){return new Range();}} public class Pattern {public Ranges GetSelection(){return new Ranges();}} public class TextPattern {public static object Pattern=new object();} public class AutomationElement { public static AutomationElement FocusedElement=new AutomationElement();public Info Current=new Info();public Pattern GetCurrentPattern(object p){return new Pattern();} } }';
$ast=[System.Management.Automation.Language.Parser]::ParseFile('` + strings.ReplaceAll(file, "'", "''") + `',[ref]$null,[ref]$null);
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Get-FocusedSummary','Get-SelectedText')},$true)|ForEach-Object {Invoke-Expression $_.Extent.Text};
if((Get-FocusedSummary 7 ([IntPtr]11)) -ne 'Edit Draft'){throw 'Current focus lost'};
if((Get-SelectedText 7 ([IntPtr]11)) -ne 'selected draft'){throw 'Current selection lost'};
if($null -ne (Get-FocusedSummary 7 ([IntPtr]12)) -or $null -ne (Get-SelectedText 7 ([IntPtr]12))){throw 'Focus crossed same-process windows'};
if($null -ne (Get-FocusedSummary 8 ([IntPtr]11)) -or $null -ne (Get-SelectedText 8 ([IntPtr]11))){throw 'Focus crossed processes'};
'foreground;same-process-window;other-process'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "foreground;same-process-window;other-process" {
		t.Fatalf("focus evidence: %v: %s", err, out)
	}
}
