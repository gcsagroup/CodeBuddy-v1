package main

import (
	"encoding/json"
	"strings"
	"testing"
)

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
