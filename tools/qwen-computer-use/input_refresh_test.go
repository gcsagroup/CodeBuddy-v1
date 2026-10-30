package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInterveningInputRefreshesWithoutDispatchOrPause(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows input gate")
	}
	dir := t.TempDir()
	// Feed deterministic events through the real RecordMouse/RecordKey gates.
	// An unrelated physical desktop user must not mutate this unit-test fixture.
	isolatedSource := strings.ReplaceAll(desktopInputSource, "code>=0 && Current()", "code==int.MinValue && Current()")
	for name, source := range map[string]string{"desktop-input.cs": isolatedSource, "runtime.ps1": windowsRuntimeScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	script := `$ErrorActionPreference='Stop'
$dir='` + strings.ReplaceAll(dir, "'", "''") + `'
Add-Type -Path "$dir/desktop-input.cs"
$ast=[System.Management.Automation.Language.Parser]::ParseFile("$dir/runtime.ps1",[ref]$null,[ref]$null)
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-DesktopOperation'},$true)|ForEach-Object{Invoke-Expression $_.Extent.Text}
# Only external UI access is stubbed. Exercise the actual native gate and the
# full operation dispatcher, including its error and after-state paths.
$script:clicks=0
$script:captures=0
function Build-Snapshot($app,$window,$process,$strict) {
 if($app -ne 'fixture' -or $window -ne 11 -or $process -ne 7 -or -not $strict){throw 'Refresh lost target identity'}
 $script:captures++
 return [pscustomobject]@{windowHandle=11;app=@{pid=7};treeLines=@("clicks=$script:clicks")}
}
function Test-EnvFlagEnabled {return $false}
function Resolve-ObservedApp {return [pscustomobject]@{MainWindowHandle=11;Id=7}}
function Get-WindowRectFrame {return [pscustomobject]@{x=0;y=0;width=100;height=100}}
function Find-Element {return [pscustomobject]@{name='button'}}
function Start-DesktopFeedback {return 0}
function Stop-DesktopFeedback {}
function Invoke-PreferredClick {$script:clicks++;return $true}
function Build-AfterActionResponse {return [pscustomobject]@{ok=$true;actionDispatched=$true;snapshot=@{windowHandle=11;app=@{pid=7}}}}
[IO.File]::WriteAllText("$dir/lease.json",'fixture-lease')
[OcuControl]::Begin($dir,'fixture-lease')
[void][OcuControl]::Prepare($true)
[OcuControl]::EndOperation()
$operation=[pscustomobject]@{tool='click';app='fixture';expectedWindow=11;expectedPid=7;controlDirectory=$dir;controlIdentity='fixture-lease';element=@{index=1};windowBounds=@{x=0;y=0;width=100;height=100}}
foreach($kind in @('mouse','wheel','keyboard')) {
 if($kind -eq 'mouse'){[OcuControl]::RecordMouse(0x201);[OcuControl]::RecordMouse(0x202)}
 if($kind -eq 'wheel'){[OcuControl]::RecordMouse(0x20A)}
 if($kind -eq 'keyboard'){[OcuControl]::RecordKey(0x09,$true);[OcuControl]::RecordKey(0x09,$false)}
 $before=$script:clicks
 $r=Invoke-DesktopOperation $operation
 if(-not $r.ok -or -not $r.inputConflict -or $r.actionDispatched -or $script:clicks -ne $before -or $r.snapshot.windowHandle -ne 11){throw "Input $kind failed to refresh without replay"}
 if(Test-Path "$dir/paused"){throw 'Brief input left a persistent pause'}
 # Plain pointer movement between this fresh observation and the next action
 # must neither invalidate it nor require another observation.
 1..1000|ForEach-Object{[OcuControl]::RecordMouse(0x200)}
 $r=Invoke-DesktopOperation $operation
 if(-not $r.ok -or -not $r.actionDispatched -or $script:clicks -ne $before+1){throw "Input $kind never recovered after refresh"}
}
if($script:captures -ne 3){throw 'Unexpected refresh loop'}
$savedSnapshot=${function:Build-Snapshot}
function Build-Snapshot {throw 'Target vanished while refreshing'}
[OcuControl]::RecordMouse(0x20A)
$r=Invoke-DesktopOperation $operation
if($r.ok -or -not $r.inputConflict -or $script:clicks -ne 3){throw 'Refresh failure hid the native input conflict'}
${function:Build-Snapshot}=$savedSnapshot
# A conflict during input can have a partial effect. It must retain a typed
# conflict receipt without retrying or claiming that nothing happened.
function Invoke-PreferredClick {$script:clicks++;[OcuControl]::RecordMouse(0x20A);return $true}
$r=Invoke-DesktopOperation $operation
if($r.ok -or -not $r.inputConflict -or $script:clicks -ne 4){throw 'In-flight conflict lost its typed receipt or replayed input'}
[OcuControl]::RecordMouse(0x201)
$r=Invoke-DesktopOperation $operation
if($r.ok -or -not $r.inputConflict -or $script:clicks -ne 4){throw 'Held input lost conflict classification'}
[OcuControl]::RecordMouse(0x202)
[OcuControl]::RecordInput($true)
$r=Invoke-DesktopOperation $operation
if($r.ok -or $r.inputConflict -or $script:clicks -ne 4){throw 'Esc allowed automatic refresh/replay or counted as conflict'}
'PASS'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil || strings.TrimSpace(string(out)) != "PASS" {
		t.Fatalf("input refresh dispatch: %v %s", err, out)
	}
}

func TestRefreshReceiptDoesNotClaimActionOrKeepOtherTargets(t *testing.T) {
	svc := newService()
	stale := &appSnapshot{App: appDescriptor{PID: 71}, WindowHandle: 901}
	svc.rememberSnapshot("other", stale)
	fresh := &appSnapshot{App: appDescriptor{PID: 72}, WindowHandle: 902, ScreenshotPNGBase64: "aW1hZ2U="}
	_, result := svc.acceptSnapshotResponse("fixture", psRequest{Tool: "click"}, psResponse{OK: true, InputConflict: true, Snapshot: fresh, Text: "Requested action was NOT dispatched; fresh state follows."})
	if result.IsError || len(result.Content) < 3 || result.Content[0].Text != "Requested action was NOT dispatched; fresh state follows." || result.StructuredContent == nil {
		t.Fatalf("refresh lost its real outcome or observation: %#v", result)
	}
	if svc.currentSnapshot("other") != nil || svc.currentSnapshot("fixture") != fresh {
		t.Fatal("refresh kept stale target or lost its new state")
	}
	_, dispatched := svc.acceptSnapshotResponse("fixture", psRequest{Tool: "click"}, psResponse{OK: true, ActionDispatched: true, Snapshot: fresh})
	if !strings.Contains(dispatched.Content[0].Text, "action_completed") || !strings.Contains(dispatched.Content[0].Text, "Do not repeat the input") {
		t.Fatal("actual dispatch evidence was lost")
	}
	if result.StructuredContent["desktop_control"].(map[string]any)["outcome"] != "input_conflict" || dispatched.StructuredContent["desktop_control"].(map[string]any)["outcome"] != "action_completed" {
		t.Fatal("native control facts were lost")
	}
	_, failed := svc.acceptSnapshotResponse("fixture", psRequest{Tool: "click"}, psResponse{InputConflict: true, Error: "partial action"})
	if !failed.IsError || failed.StructuredContent["desktop_control"].(map[string]any)["outcome"] != "input_conflict" {
		t.Fatal("error lost conflict fact")
	}
	for _, response := range []psResponse{{OK: true, Snapshot: fresh}, {OK: true, ActionDispatched: true}, {Error: "DESKTOP_INPUT_CONFLICT prose is not a fact"}} {
		if response.controlReceipt(textResult("", false)).StructuredContent != nil {
			t.Fatal("observation, unknown action or prose became control fact")
		}
	}
	_, conflicted := svc.acceptSnapshotResponse("fixture", psRequest{Tool: "click"}, psResponse{OK: true, ActionDispatched: true, InputConflict: true, Snapshot: fresh})
	if strings.Contains(conflicted.Content[0].Text, "action_completed") || strings.Contains(result.Content[0].Text, "action_completed") {
		t.Fatal("conflicted or unexecuted input was presented as completed")
	}
}
