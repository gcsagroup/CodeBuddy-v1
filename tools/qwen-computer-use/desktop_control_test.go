package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDesktopMCPDispatcherEnforcesHostLease(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skip("native desktop platforms")
	}
	t.Setenv("CODEBUDDY_DESKTOP_MANAGED", "1")
	t.Setenv("CODEBUDDY_DESKTOP_CONTROL_DIRECTORY", t.TempDir())
	svc := newService()
	defer svc.close()
	response := handleMCPRequest(map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": "list_apps"}}, svc)
	encoded, err := json.Marshal(response)
	if err != nil || !strings.Contains(string(encoded), "current host lease") || !strings.Contains(string(encoded), "control_unavailable") || svc.bridge.cmd != nil {
		t.Fatalf("MCP dispatcher bypassed native host gate: %s %v", encoded, err)
	}
}

func TestDesktopLeaseRequiresHostIdentityAndInvalidatesObservations(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("CODEBUDDY_DESKTOP_CONTROL_DIRECTORY", directory)
	t.Setenv("CODEBUDDY_DESKTOP_MANAGED", "1")
	svc := newService()
	if svc.prepareDesktopControl(map[string]any{}) == nil {
		t.Fatal("missing lease accepted")
	}
	params := func(g string) map[string]any {
		return map[string]any{"_meta": map[string]any{"codebuddy/desktop-control": map[string]any{"token": "A", "generation": g}}}
	}
	lease := filepath.Join(directory, "lease.json")
	if err := os.WriteFile(lease, []byte(`{"version":1,"token":"A","generation":"first"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := svc.prepareDesktopControl(params("first")); err != nil {
		t.Fatal(err)
	}
	svc.snapshots["fixture"] = &appSnapshot{}
	if err := svc.prepareDesktopControl(params("first")); err != nil || len(svc.snapshots) != 1 {
		t.Fatal("same lease lost valid observations", err)
	}
	if svc.prepareDesktopControl(params("forged")) == nil {
		t.Fatal("wrong generation accepted")
	}
	if err := os.WriteFile(filepath.Join(directory, "paused"), []byte("human"), 0600); err != nil {
		t.Fatal(err)
	}
	if svc.prepareDesktopControl(params("first")) == nil {
		t.Fatal("human takeover ignored")
	}
	if err := os.Remove(filepath.Join(directory, "paused")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lease, []byte(`{"version":1,"token":"A","generation":"resumed"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := svc.prepareDesktopControl(params("resumed")); err != nil {
		t.Fatal(err)
	}
	if len(svc.snapshots) != 0 {
		t.Fatal("resume retained stale elements")
	}
}

func TestNativeDesktopGateChecksPauseAndChangedLease(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows native control")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "desktop-input.cs")
	if err := os.WriteFile(source, []byte(desktopInputSource), 0600); err != nil {
		t.Fatal(err)
	}
	script := `$ErrorActionPreference='Stop'
Add-Type -Path '` + strings.ReplaceAll(source, "'", "''") + `'
$dir='` + strings.ReplaceAll(dir, "'", "''") + `'
$lease=Join-Path $dir 'lease.json'
[IO.File]::WriteAllText($lease,'test-lease')
try {
 [OcuControl]::Begin($dir,'test-lease')
 [OcuControl]::Check()
 [IO.File]::WriteAllText((Join-Path $dir 'paused'),'human')
 $blocked=$false;try{[OcuControl]::Check()}catch{$blocked=$true}
 if(-not $blocked){throw 'Takeover failed to fence native input'}
 [IO.File]::Delete((Join-Path $dir 'paused'))
 [IO.File]::WriteAllText($lease,'new-lease')
 $blocked=$false;try{[OcuControl]::Check()}catch{$blocked=$true}
 if(-not $blocked){throw 'Old native observation remained executable'}
 if([OcuControl]::ExternalInput(1,[OcuControl]::InputTag.ToUInt64())){throw 'Own injection triggered takeover'}
 if(-not [OcuControl]::ExternalInput(0,0)){throw 'Physical input ignored'}
 if(-not [OcuControl]::ExternalInput(1,123)){throw 'Other automation ignored'}
 [OcuControl]::EndOperation()
 [OcuControl]::Begin($dir,'new-lease')
 [OcuControl]::RecordMouse(0x200)
 [OcuControl]::Check()
 [OcuControl]::RecordMouse(0x201)
 $blocked=$false;try{[void][OcuControl]::Prepare($true)}catch{$blocked=$_.Exception.Message.Contains('DESKTOP_INPUT_CONFLICT')}
 if(-not $blocked){throw 'Held mouse button was treated as idle input'}
 [OcuControl]::RecordMouse(0x202)
 if(Test-Path (Join-Path $dir 'paused')){throw 'Ordinary input created persistent pause'}
 if([OcuControl]::Prepare($false)){throw 'Old action survived conflicting input'}
 [void][OcuControl]::Prepare($true)
 [OcuControl]::Check()
 [OcuControl]::RecordInput($false)
 $blocked=$false;try{[OcuControl]::Check()}catch{$blocked=$_.Exception.Message.Contains('DESKTOP_INPUT_CONFLICT')}
 if(-not $blocked){throw 'In-flight conflict ignored'}
 [void][OcuControl]::Prepare($true)
 [void][OcuControl]::Prepare($false)
 [OcuControl]::RecordKey(0x11,$true)
 $blocked=$false;try{[void][OcuControl]::Prepare($true)}catch{$blocked=$_.Exception.Message.Contains('DESKTOP_INPUT_CONFLICT')}
 if(-not $blocked){throw 'Held modifier was treated as idle input'}
 [OcuControl]::RecordKey(0x11,$false)
 [void][OcuControl]::Prepare($true)
 [OcuControl]::RecordInput($true)
 if(-not (Test-Path (Join-Path $dir 'paused'))){throw 'Esc no longer fences input'}
}finally{[OcuControl]::EndOperation()}
'PASS'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil || strings.TrimSpace(string(out)) != "PASS" {
		t.Fatalf("native takeover gate: %v %s", err, out)
	}
}

func TestStandaloneMCPDoesNotBypassReservedDesktop(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("CODEBUDDY_DESKTOP_CONTROL_DIRECTORY", directory)
	t.Setenv("CODEBUDDY_DESKTOP_MANAGED", "")
	svc := newService()
	if err := svc.prepareDesktopControl(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "lease.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if svc.prepareDesktopControl(map[string]any{}) == nil {
		t.Fatal("standalone client bypassed owner")
	}
}
