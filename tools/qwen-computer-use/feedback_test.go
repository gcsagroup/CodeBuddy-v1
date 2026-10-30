package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDesktopFeedbackPresentationContract(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows feedback")
	}
	source := filepath.Join(t.TempDir(), "desktop-feedback.cs")
	if err := os.WriteFile(source, []byte(desktopFeedbackSource), 0600); err != nil {
		t.Fatal(err)
	}
	// Compile the shipped renderer; inspect state without sending desktop input.
	script := `$ErrorActionPreference='Stop'
Add-Type -Path '` + strings.ReplaceAll(source, "'", "''") + `' -ReferencedAssemblies System.Drawing,System.Windows.Forms
foreach($kind in @('click','right_click','double_click','drag','scroll_up','scroll_down','scroll_left','scroll_right','type_text','set_value','press_key','get_app_state','open_path')) {
 if([string]::IsNullOrEmpty([OcuFeedback]::Label($kind,$true)) -or [string]::IsNullOrEmpty([OcuFeedback]::Label($kind,$false))){throw 'Missing feedback'}
}
# Exercise production transition without constructing a desktop window.
$current=[OcuFeedback+Frame]::new()
$current.Id=2;$current.Active=$true;$current.Kind='type_text'
$state=[OcuFeedback]::Complete($current,1,$true,100)
if($state.Id -ne 2 -or -not $state.Active -or $state.Failed){throw 'Stale result replaced current operation'}
$state=[OcuFeedback]::Complete($current,2,$false,100)
if($state.Active -or $state.Failed -or $state.Pointer){throw 'Text operation outcome is wrong'}
if(-not [OcuFeedback]::Complete($current,2,$true,100).Failed){throw 'Failure not represented'}
$env:CODEBUDDY_DESKTOP_FEEDBACK='0'
if([OcuFeedback]::Begin('click',0,0,$true) -ne 0){throw 'Disabled feedback publishes an operation'}
'PASS'`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(command)
	if out, err := command.CombinedOutput(); err != nil || strings.TrimSpace(string(out)) != "PASS" {
		t.Fatalf("feedback contract: %v %s", err, out)
	}
}

func TestDesktopFeedbackNativeLifecycle(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("CODEBUDDY_RUN_DESKTOP_TESTS") != "1" {
		t.Skip("opt-in visible Windows feedback integration test")
	}
	source := filepath.Join(t.TempDir(), "desktop-feedback.cs")
	probe := `
public static class FeedbackProbe {
 [System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr FindWindow(string cls,string title);
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h,int index);
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(System.IntPtr h,out uint affinity);
 delegate bool EnumProc(System.IntPtr h,System.IntPtr data);
 [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,System.IntPtr data);
 [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(System.IntPtr h,out uint pid);
 [System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetWindowText(System.IntPtr h,System.Text.StringBuilder text,int size);
 public static string Windows() {var all=new System.Text.StringBuilder();EnumWindows(delegate(System.IntPtr h,System.IntPtr data){uint pid;GetWindowThreadProcessId(h,out pid);if(pid==System.Diagnostics.Process.GetCurrentProcess().Id){var title=new System.Text.StringBuilder(200);GetWindowText(h,title,200);all.Append(h+":"+title+"; ");}return true;},System.IntPtr.Zero);return all.ToString();}
}`
	if err := os.WriteFile(source, []byte(desktopFeedbackSource+probe), 0600); err != nil {
		t.Fatal(err)
	}
	script := `$ErrorActionPreference='Stop'
Add-Type -Path '` + strings.ReplaceAll(source, "'", "''") + `' -ReferencedAssemblies System.Drawing,System.Windows.Forms
$foreground=[FeedbackProbe]::GetForegroundWindow()
$token=[OcuFeedback]::Begin('click',600,400,$true)
$ready=[Diagnostics.Stopwatch]::StartNew()
do {$window=[FeedbackProbe]::FindWindow([NullString]::Value,'CodeBuddy 操作提示');if($window -ne [IntPtr]::Zero -and [FeedbackProbe]::IsWindowVisible($window)){break};Start-Sleep -Milliseconds 50} while($ready.ElapsedMilliseconds -lt 3000)
if($window -eq [IntPtr]::Zero -or -not [FeedbackProbe]::IsWindowVisible($window)){throw ('Native feedback not visible; token='+$token+' windows='+[FeedbackProbe]::Windows())}
$style=[FeedbackProbe]::GetWindowLong($window,-20)
foreach($flag in @(0x08000000,0x00080000,0x20,0x80)){if(($style -band $flag) -eq 0){throw 'Missing non-interfering window style'}}
if([FeedbackProbe]::GetForegroundWindow() -ne $foreground){throw 'Feedback stole foreground'}
$affinity=[uint32]0
if(-not [FeedbackProbe]::GetWindowDisplayAffinity($window,[ref]$affinity) -or $affinity -ne 0x11){throw 'Overlay would contaminate capture'}
$timer=[Diagnostics.Stopwatch]::StartNew()
for($i=0;$i -lt 1000;$i++){$token=[OcuFeedback]::Begin('type_text',600,400,$false)}
$timer.Stop()
if($timer.ElapsedMilliseconds -gt 1500){throw 'Animation publication blocks the action producer'}
[OcuFeedback]::End($token,$true)
Start-Sleep -Milliseconds 1200
if([FeedbackProbe]::IsWindowVisible($window)){throw 'Failure feedback did not disappear'}
$token=[OcuFeedback]::Begin('scroll_down',600,400,$true)
Start-Sleep -Milliseconds 100
if(-not [FeedbackProbe]::IsWindowVisible($window)){throw 'Idle worker did not wake'}
[OcuFeedback]::End($token,$false)
Start-Sleep -Milliseconds 1200
if([FeedbackProbe]::IsWindowVisible($window)){throw 'Success feedback did not disappear'}
Write-Output ('PASS: styles, foreground, capture exclusion, fade, wake; 1000 updates '+$timer.ElapsedMilliseconds+' ms')`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideRuntimeWindow(command)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("native feedback: %v %s", err, out)
	}
	t.Log(strings.TrimSpace(string(out)))
}
