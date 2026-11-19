package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWindowsTextPacketsRejectLossyLinesWithoutDispatch(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows keyboard packets")
	}
	file := filepath.Join(t.TempDir(), "desktop-input.cs")
	if err := os.WriteFile(file, []byte(desktopInputSource), 0600); err != nil {
		t.Fatal(err)
	}
	script := `$ErrorActionPreference='Stop';
Add-Type -Path '` + strings.ReplaceAll(file, "'", "''") + `';
$method=[OcuDesktop].GetMethod('TextInputs',[Reflection.BindingFlags]'NonPublic,Static');
$value='A'+[char]0x4E2D+[char]0xD83D+[char]0xDE42+'C'+[char]9+'$';
$expected=@(65,0x4E2D,0xD83D,0xDE42,67,9,36);
$packets=$method.Invoke($null,@($value));
if($packets.Count -ne 2*$expected.Count){throw 'Text length/newline normalization changed'};
for($i=0;$i -lt $expected.Count;$i++) {
 $down=$packets[2*$i];$up=$packets[2*$i+1];
 if($down.type -ne 1 -or $up.type -ne 1 -or $down.data.key.vk -ne 0 -or $up.data.key.vk -ne 0){throw 'Literal text became a keyboard shortcut'};
 if($down.data.key.scan -ne $expected[$i] -or $up.data.key.scan -ne $expected[$i] -or $down.data.key.flags -ne 4 -or $up.data.key.flags -ne 6){throw 'Unicode packet mismatch'};
};
if($method.Invoke($null,@('')).Count -ne 0){throw 'Empty input dispatched'};
if([OcuDesktop]::CanSetEditText([IntPtr]::Zero,[IntPtr]::Zero)){throw 'Unknown edit offered for replacement'};
foreach($invalid in @(('x'*501),('a'+[char]10+'b'),('a'+[char]13+'b'),('a'+[char]0+'b'))) {
 $rejected=$false;try {[OcuDesktop]::SetEditText([IntPtr]::Zero,[IntPtr]::Zero,'',$invalid)}catch{$rejected=$_.Exception.Message.Contains('short single-line')};
 if(-not $rejected){throw 'Invalid native replacement reached input dispatch'};
};
foreach($newline in @(([string][char]10),([string][char]13+[char]10),([string][char]13))) {
 $rejected=$false;try {$method.Invoke($null,@('prefix'+$newline+'suffix'))|Out-Null}catch{$rejected=$true};
 if(-not $rejected){throw 'Lossy multiline input accepted'};
};
'LF-rejected;CRLF-rejected;CR-rejected;Unicode;surrogate;tab;literal-only'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "LF-rejected;CRLF-rejected;CR-rejected;Unicode;surrogate;tab;literal-only" {
		t.Fatalf("text packets: %v: %s", err, out)
	}
}
