package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestFieldReadbackRequiresPresentValuesAndPreservesVisualFallback(t *testing.T) {
	empty := ""
	s := &appSnapshot{fieldCapture: "sample", App: appDescriptor{PID: 42}, WindowHandle: 10,
		Foreground: &foregroundWindow{PID: 42, WindowHandle: 10}, FocusedHandle: 33,
		ScreenshotPNGBase64: "aW1n", TreeLines: []string{"1 label with bounds"},
		Elements: []elementRecord{{Index: 7, NativeWindowHandle: 33, NativeEditText: &empty}}}
	check := func(want bool) {
		t.Helper()
		r := s.result()
		meta := r.StructuredContent["desktop_observation"].(map[string]any)
		if (meta["has_field_readback"] == true) != want || len(r.Content) != 2 || r.Content[1].Type != "image" {
			t.Fatalf("invalid routing hint or lost original image: %v", meta)
		}
	}
	check(true)
	if text := s.renderedText(); !strings.Contains(text, "1 label with bounds") || !strings.Contains(text, `7 value="" keyboard_focus=true`) {
		t.Fatal(text)
	}
	s.Foreground.WindowHandle++
	if strings.Contains(s.renderedText(), "keyboard_focus=true") {
		t.Fatal("wrong foreground window")
	}
	s.Elements[0].NativeEditText = nil
	check(false)
	s.Elements[0].WritableField = true
	check(true)
	s.fieldCapture = ""
	check(false)
}

func TestFieldsViewBindsSelectionsToOneObservation(t *testing.T) {
	svc := newService()
	defer svc.close()
	const app = "window:42:101"
	observe := func(fields bool) *appSnapshot {
		snap, result := svc.acceptSnapshotResponse(app, psRequest{Tool: "get_app_state", FieldView: fields}, psResponse{
			OK: true, Snapshot: &appSnapshot{
				App: appDescriptor{PID: 42}, WindowHandle: 101, ScreenshotPNGBase64: "cGl4ZWxz",
				TreeLines: []string{"0 Edit 替换", "1 Button 全部替换", "2 Document 文本编辑器 Value: B区：待复核"}, FocusedSummary: "文本编辑器", Elements: []elementRecord{
					{Index: 0, RuntimeID: []int{42, 1}, Name: "替换", WritableField: true},
					{Index: 1, RuntimeID: []int{42, 2}, Name: "全部替换"},
				},
			},
		})
		if result.IsError || len(result.Content) != 2 || result.Content[1].Type != "image" {
			t.Fatalf("missing observation: %v", result)
		}
		return snap
	}
	first := observe(true)
	old := first.fieldToken(first.Elements[0].Index)
	meta := first.result().StructuredContent["desktop_observation"].(map[string]any)
	fields := meta["field_candidates"].([]map[string]any)
	if len(fields) != 1 || fields[0]["id"] != old || fields[0]["operation"] != "set_value" || meta["capture_id"] != first.fieldCapture {
		t.Fatalf("structured fields must use the existing snapshot-bound tokens: %v", meta)
	}
	for _, want := range []string{old, "全部替换", "B区：待复核", "focused UI element is 文本编辑器"} {
		if !strings.Contains(first.renderedText(), want) {
			t.Fatalf("field view discarded available control evidence %q", want)
		}
	}
	second := observe(true)
	if !strings.Contains(second.TreeLines[0], `set_value element_index="`+second.fieldToken(second.Elements[0].Index)+`"`) ||
		strings.Contains(second.TreeLines[0], old) || strings.Contains(second.TreeLines[1], "set_value") {
		t.Fatalf("write hints must identify exactly the offered field in this capture: %v", second.TreeLines)
	}
	for _, invalid := range []string{old, second.fieldToken(second.Elements[1].Index), "0"} {
		if result := svc.setValue(app, invalid, "test"); !result.IsError {
			t.Fatalf("accepted unoffered selection %s", invalid)
		}
	}
	if r := svc.setValue(app, fmt.Sprint(second.Elements[0].Index), "test"); !r.IsError || !strings.Contains(r.Content[0].Text, second.fieldToken(second.Elements[0].Index)) {
		t.Fatal("a plain number must not write; report the matching current field token")
	}
	full := observe(false)
	if !strings.Contains(full.renderedText(), "全部替换") || full.fieldCapture != "" || strings.Contains(full.TreeLines[0], "field-") {
		t.Fatal("full observation should preserve the ordinary tree")
	}
}

func TestNativeFieldCandidatesKeepLabelsAndDistinctTokens(t *testing.T) {
	value := ""
	snapshot := &appSnapshot{fieldCapture: "native", App: appDescriptor{PID: 42}, WindowHandle: 101,
		ScreenshotPNGBase64: "cGl4ZWxz", TreeLines: []string{"1 Label 公司", "3 Label 工作邮箱"},
		Elements: []elementRecord{{Index: 2, WritableField: true, NativeEditText: &value}, {Index: 4, WritableField: true, NativeEditText: &value}}}
	text := snapshot.renderedText()
	for _, expected := range []string{"1 Label 公司", "3 Label 工作邮箱", "field-native/2", "field-native/4"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing field context %q: %s", expected, text)
		}
	}
	fields := snapshot.result().StructuredContent["desktop_observation"].(map[string]any)["field_candidates"].([]map[string]any)
	if len(fields) != 2 || fields[0]["id"] == fields[1]["id"] {
		t.Fatal("same-label fields collapsed", fields)
	}
}

func TestWindowsActionAfterFullObservationReturnsCurrentControls(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows framed bridge")
	}
	for _, nextWindow := range []int64{101, 202} {
		svc := newService()
		app := "window:42:101"
		prior := &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: 101, InputVersion: "9", ScreenshotPNGBase64: "cGl4ZWxz"}
		_, full := svc.acceptSnapshotResponse(app, psRequest{Tool: "get_app_state"}, psResponse{OK: true, Snapshot: prior})
		if full.StructuredContent["desktop_observation"].(map[string]any)["view"] == "fields" {
			t.Fatal("explicit full observation lost visual routing")
		}
		after := &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: nextWindow, ScreenshotPNGBase64: "bmV3", TreeLines: []string{"1 Document Value: B区：已复核"}}
		wire, err := json.Marshal(psResponse{OK: true, ActionDispatched: true, Snapshot: after})
		if err != nil {
			t.Fatal(err)
		}
		input := &recordedTextInput{}
		svc.bridge.cmd = &exec.Cmd{}
		svc.bridge.in = input
		svc.bridge.out = bufio.NewReader(strings.NewReader(string(wire) + "\n"))
		result := svc.actionResult(app, psRequest{Tool: "press_key", App: app, Key: "ctrl+s"})
		var request psRequest
		if err := json.Unmarshal(input.Bytes(), &request); err != nil {
			t.Fatal(err)
		}
		if !request.FieldView || request.InputVersion != "9" || request.ExpectedWindow != 101 || request.ExpectedPID != 42 {
			t.Fatalf("lost control-first request or input guards: %#v", request)
		}
		meta := result.StructuredContent["desktop_observation"].(map[string]any)
		if (meta["view"] == "fields") != (nextWindow == 101) {
			t.Fatalf("wrong after-state routing: %v", meta)
		}
		if result.Content[len(result.Content)-1].Type != "image" {
			t.Fatal("original after-image lost")
		}
		if nextWindow != 101 && svc.currentSnapshot(app) != nil {
			t.Fatal("transition retained stale target")
		}
	}
}

func TestOwnActionCaptionChangeKeepsExactWindowScope(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows framed bridge")
	}
	for _, tc := range []struct {
		name                          string
		pid                           int
		window                        int64
		dispatched, conflict, inherit bool
	}{
		{"own edit", 42, 101, true, false, true},
		{"other window", 42, 202, true, false, false},
		{"other process", 99, 101, true, false, false},
		{"external rename", 42, 101, false, false, false},
		{"conflicted input", 42, 101, true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := newService()
			svc.windowTitle = "draft.txt - Editor"
			app := "window:42:101"
			svc.acceptSnapshotResponse(app, psRequest{Tool: "get_app_state"}, psResponse{OK: true, Snapshot: &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: 101, WindowTitle: svc.windowTitle}})
			input := &recordedTextInput{}
			after := &appSnapshot{App: appDescriptor{PID: tc.pid}, WindowHandle: tc.window, WindowTitle: "*draft.txt - Editor", ScreenshotPNGBase64: "bmV3"}
			wire, _ := json.Marshal(psResponse{OK: true, ActionDispatched: tc.dispatched, InputConflict: tc.conflict, Snapshot: after})
			svc.bridge.cmd = &exec.Cmd{}
			svc.bridge.in = input
			svc.bridge.out = bufio.NewReader(strings.NewReader(string(wire) + "\n"))
			result := svc.actionResult(app, psRequest{Tool: "type_text", App: app, Text: "correction"})
			if result.IsError {
				t.Fatal(result)
			}
			next := svc.currentSnapshot(app)
			if (next != nil && next.scopeTitle == svc.windowTitle) != tc.inherit {
				t.Fatalf("incorrect scope inheritance: %#v", next)
			}
			if !tc.inherit {
				return
			}
			input.Reset()
			svc.bridge.out = bufio.NewReader(strings.NewReader(string(wire) + "\n"))
			svc.getAppState(app, true)
			var req psRequest
			if err := json.Unmarshal(input.Bytes(), &req); err != nil {
				t.Fatal(err)
			}
			if req.WindowTitle != "*draft.txt - Editor" || req.ExpectedWindow != 101 || req.ExpectedPID != 42 || svc.windowTitle != "draft.txt - Editor" {
				t.Fatalf("scope broadened or saved caption not used: %#v", req)
			}
		})
	}
}

func TestWindowMovementIsObservableWithoutChangingInputCoordinates(t *testing.T) {
	snapshot := &appSnapshot{
		App: appDescriptor{Name: "TextEdit", PID: 42}, WindowHandle: 101,
		WindowBounds:        &frame{X: -500.5, Y: 30, Width: 640, Height: 480},
		ScreenshotPNGBase64: "cGl4ZWxz",
	}
	before := snapshot.renderedText()
	snapshot.WindowBounds.X += 40
	snapshot.WindowBounds.Y += 30
	after := snapshot.renderedText()
	for text, position := range map[string]string{
		before: "screen coordinates: x -500.5, y 30.0",
		after:  "screen coordinates: x -460.5, y 60.0",
	} {
		for _, want := range []string{position, "Observed target: window:42:101", "Input coordinate space: window-local", "width 640, height 480", "origin (0,0)"} {
			if !strings.Contains(text, want) {
				t.Fatalf("window movement evidence lost %q: %s", want, text)
			}
		}
	}
	snapshot.ScreenshotPNGBase64 = ""
	if strings.Contains(snapshot.renderedText(), "Observed window position") {
		t.Fatal("hidden window advertised a fresh visual position")
	}
}

func TestObservationReceiptRequiresAfterImageAndBindsWindow(t *testing.T) {
	snapshot := &appSnapshot{App: appDescriptor{Name: "Calculator", PID: 42}, WindowHandle: 101, WindowTitle: "计算器"}
	if snapshot.result().StructuredContent != nil {
		t.Fatal("hidden snapshot claims an observed screen")
	}
	snapshot.ScreenshotPNGBase64 = "cGl4ZWxz"
	result := snapshot.result()
	bytes, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		StructuredContent struct {
			Observation struct {
				PID          int
				WindowHandle int64 `json:"window_handle"`
			} `json:"desktop_observation"`
		} `json:"structuredContent"`
	}
	if err := json.Unmarshal(bytes, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.StructuredContent.Observation.PID != 42 || wire.StructuredContent.Observation.WindowHandle != 101 {
		t.Fatalf("window binding lost: %s", bytes)
	}
	if len(result.Content) != 2 || result.Content[1].Type != "image" {
		t.Fatal("receipt lost its visual evidence")
	}
}

func TestButtonOnlyControlViewPreservesReadoutAndExplicitVisualFallback(t *testing.T) {
	s := &appSnapshot{App: appDescriptor{Name: "Calculator", PID: 42}, WindowHandle: 101,
		ScreenshotPNGBase64: "cGl4ZWxz", fieldCapture: "calculator",
		TreeLines: []string{"1 Text 显示为 888", "2 Button 等于"},
		Elements:  []elementRecord{{Index: 1, ControlType: "Text", Name: "显示为 888"}, {Index: 2, ControlType: "Button", Name: "等于"}}}
	r := s.result()
	meta := r.StructuredContent["desktop_observation"].(map[string]any)
	if meta["view"] != "fields" || meta["has_field_readback"] == true || !strings.Contains(r.Content[0].Text, "显示为 888") || len(r.Content) != 2 {
		t.Fatalf("button-only control evidence lost: %#v", r)
	}
	s.fieldCapture = ""
	if s.result().StructuredContent["desktop_observation"].(map[string]any)["view"] == "fields" {
		t.Fatal("explicit full observation suppressed image interpretation")
	}
}

func TestMinimizedWindowRetainsControlViewWithoutInventingImageEvidence(t *testing.T) {
	svc := newService()
	defer svc.close()
	const app = "window:42:101"
	hidden, result := svc.acceptSnapshotResponse(app, psRequest{Tool: "get_app_state", FieldView: true}, psResponse{
		OK: true, Snapshot: &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: 101},
	})
	if result.IsError || !hidden.fieldView || hidden.fieldCapture != "" || result.StructuredContent != nil {
		t.Fatalf("minimized control view was lost or advertised nonexistent pixels: %#v", hidden)
	}
	for _, tc := range []struct {
		name   string
		fields bool
		window int64
		want   bool
	}{
		{"restored same window", hidden.fieldView, 101, true},
		{"explicit visual request", false, 101, false},
		{"different window", hidden.fieldView, 202, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot, receipt := svc.acceptSnapshotResponse(app, psRequest{Tool: "perform_secondary_action", FieldView: tc.fields, ExpectedPID: 42, ExpectedWindow: 101}, psResponse{
				OK: true, ActionDispatched: true, Snapshot: &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: tc.window,
					ScreenshotPNGBase64: "cGl4ZWxz", TreeLines: []string{"1 Text 31.75", "2 Button 长度"}},
			})
			if receipt.IsError || snapshot.fieldView != tc.want || (snapshot.fieldCapture != "") != tc.want {
				t.Fatalf("incorrect after-state view: %#v", snapshot)
			}
			meta := receipt.StructuredContent["desktop_observation"].(map[string]any)
			if (meta["view"] == "fields") != tc.want || len(receipt.Content) < 2 {
				t.Fatalf("lost requested mode or original evidence: %#v", receipt)
			}
		})
	}
}
