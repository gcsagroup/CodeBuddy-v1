package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestElementFallbackUsesOneLiveEnumeration(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bridge")
	}
	file := filepath.Join(t.TempDir(), "runtime.ps1")
	if err := os.WriteFile(file, []byte(windowsRuntimeScript), 0600); err != nil {
		t.Fatal(err)
	}
	// UIA can recreate a control's runtime ID without changing its automation ID.
	// Exercise the actual lookup against a counted provider, without GUI input.
	script := `$ErrorActionPreference='Stop';
$ast=[System.Management.Automation.Language.Parser]::ParseFile('` + strings.ReplaceAll(file, "'", "''") + `',[ref]$null,[ref]$null);
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Find-Element','Same-RuntimeId')},$true)|ForEach-Object {Invoke-Expression $_.Extent.Text};
$script:reads=0;
$element=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='editor';Name='Text';ControlType=[pscustomobject]@{ProgrammaticName='ControlType.Edit'}}};
$element|Add-Member ScriptMethod GetRuntimeId {return @(7,2)};
function Get-MainElement {return 'root'};
function Get-AllElements {$script:reads++;return @($element)};
foreach($id in @(@(7,2),@(7,1))) {
 $script:reads=0;
 $record=[pscustomobject]@{runtimeId=$id;automationId='editor';name='Text';controlType='ControlType.Edit'};
 if((Find-Element 'app' $record) -ne $element){throw 'Recreated editor lost'};
 if($script:reads -ne 1){throw "Redundant provider enumeration: $script:reads"};
};
$script:reads=0;$record.automationId='missing';$record.name='missing';
if($null -ne (Find-Element 'app' $record)){throw 'Missing element matched'};
if($script:reads -ne 1){throw 'Missing element repeatedly enumerated'};
'exact;recreated;missing;one-enumeration'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "exact;recreated;missing;one-enumeration" {
		t.Fatalf("element lookup: %v: %s", err, out)
	}
}
