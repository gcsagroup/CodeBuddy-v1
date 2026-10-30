package main

import "testing"

func TestClosedLauncherAfterStateDoesNotRetargetItsIdentity(t *testing.T) {
	s := newService()
	launcher := &appSnapshot{App: appDescriptor{Name: "Launcher", PID: 7}, WindowHandle: 11}
	s.rememberSnapshot("foreground", launcher)
	opened := &appSnapshot{App: appDescriptor{Name: "Calculator", PID: 8}, WindowHandle: 12,
		Foreground: &foregroundWindow{Name: "Calculator", PID: 8, WindowHandle: 12}}
	_, result := s.acceptSnapshotResponse("window:7:11", psRequest{Tool: "press_key", ExpectedPID: 7, ExpectedWindow: 11},
		psResponse{OK: true, ActionDispatched: true, Snapshot: opened})
	if result.IsError || s.currentSnapshot("window:7:11") != nil || s.currentSnapshot("Launcher") != nil {
		t.Fatal("closed launcher identity was retained or retargeted")
	}
	if s.currentSnapshot("foreground") != opened || s.currentSnapshot("window:8:12") != opened {
		t.Fatal("verified new foreground observation was lost")
	}
	if result.StructuredContent["desktop_control"].(map[string]any)["outcome"] != "action_completed" {
		t.Fatal("completed launch was treated as a failed input")
	}
}

func TestSystemPanelTransitionExpiresDynamicForegroundAlias(t *testing.T) {
	s := newService()
	before := &appSnapshot{App: appDescriptor{Name: "Editor", PID: 7}, WindowHandle: 11}
	s.rememberSnapshot("foreground", before)
	after := &appSnapshot{App: before.App, WindowHandle: 11, Foreground: &foregroundWindow{Name: "System panel", PID: 8, WindowHandle: 12}}
	s.acceptSnapshotResponse("foreground", psRequest{Tool: "press_key"}, psResponse{OK: true, ActionDispatched: true, Snapshot: after})
	if s.currentSnapshot("foreground") != nil || s.currentSnapshot("window:8:12") != nil {
		t.Fatal("old-window image became an observation of the system panel")
	}
	if s.currentSnapshot("window:7:11") != after {
		t.Fatal("original window's real after-state was lost")
	}
	if result := s.typeText("foreground", "must not reach the old editor"); !result.IsError {
		t.Fatal("typing accepted without observing the newly focused window")
	}
	panel := &appSnapshot{App: appDescriptor{Name: "System panel", PID: 8}, WindowHandle: 12,
		Foreground: after.Foreground}
	s.rememberSnapshot("foreground", panel)
	if s.currentSnapshot("foreground") != panel || s.currentSnapshot("window:8:12") != panel {
		t.Fatal("fresh system panel observation was not addressable")
	}
}

func TestFreshWindowStateUpdatesAllObservedAliases(t *testing.T) {
	s := newService()
	minimized := &appSnapshot{App: appDescriptor{Name: "FrameHost", PID: 42}, WindowHandle: 101, WindowBounds: &frame{Width: 0, Height: 0}}
	s.rememberSnapshot("HostedApp", minimized)
	other := &appSnapshot{App: appDescriptor{Name: "Other", PID: 43}, WindowHandle: 102}
	s.rememberSnapshot("Other", other)
	restored := &appSnapshot{App: minimized.App, WindowHandle: 101, WindowBounds: &frame{Width: 1558, Height: 1212}}
	s.rememberSnapshot("FrameHost", restored)
	for _, alias := range []string{"HostedApp", "FrameHost", "42"} {
		if s.currentSnapshot(alias) != restored {
			t.Fatalf("%s retains pre-restore geometry", alias)
		}
	}
	if s.currentSnapshot("Other") != other {
		t.Fatal("unrelated window changed")
	}
	// Reused handles owned by another process must not retarget old app aliases.
	replacement := &appSnapshot{App: appDescriptor{Name: "Replacement", PID: 99}, WindowHandle: 101}
	s.rememberSnapshot("Replacement", replacement)
	if s.currentSnapshot("HostedApp") != restored {
		t.Fatal("old alias retargeted to new process")
	}
}

func TestMutationExpiresOtherWindowSnapshots(t *testing.T) {
	s := newService()
	content := &appSnapshot{App: appDescriptor{Name: "Content", PID: 7}, WindowHandle: 11}
	shell := &appSnapshot{App: appDescriptor{Name: "Frame", PID: 42}, WindowHandle: 101}
	s.rememberSnapshot("Content", content)
	s.rememberSnapshot("foreground", shell)
	fresh := &appSnapshot{App: shell.App, WindowHandle: 101, WindowBounds: &frame{Width: 1558, Height: 1212}}
	s.acceptSnapshotResponse("Frame", psRequest{Tool: "perform_secondary_action", ExpectedWindow: 101, ExpectedPID: 42}, psResponse{OK: true, ActionDispatched: true, Snapshot: fresh})
	if s.currentSnapshot("Content") != nil {
		t.Fatal("content window keeps stale pre-restore state")
	}
	if s.currentSnapshot("foreground") != fresh {
		t.Fatal("observed frame alias lost its after-state")
	}
	r := s.click("Content", "", nil, nil, 1, "left")
	if !r.IsError {
		t.Fatal("expired window accepted input")
	}
}
