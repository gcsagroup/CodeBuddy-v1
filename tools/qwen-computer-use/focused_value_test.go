package main

import (
	"bufio"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestFocusedValueUsesObservedBindingAndKeepsLegacyRequest(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS optional focused write")
	}
	for _, focus := range []bool{false, true} {
		s := newService()
		app := "window:42:101"
		e := elementRecord{Index: 8, ControlType: "AXTextField", RuntimeID: []int{0, 2}, Value: "old"}
		s.snapshots[app] = &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: 101, InputVersion: "human-version", WindowBounds: &frame{Width: 600, Height: 400}, Elements: []elementRecord{e}}
		in := &recordedTextInput{}
		s.bridge.cmd = &exec.Cmd{}
		s.bridge.in = in
		s.bridge.out = bufio.NewReader(strings.NewReader(`{"ok":true,"actionDispatched":true,"snapshot":{"app":{"pid":42},"windowHandle":101}}` + "\n"))
		args := map[string]any{"app": app, "element_index": "8", "value": "new"}
		if focus {
			args["focus"] = true
		}
		if result := s.callTool("set_value", args); result.IsError {
			t.Fatal(result)
		}
		var request psRequest
		if err := json.Unmarshal(in.Bytes(), &request); err != nil {
			t.Fatal(err)
		}
		if request.Focus != focus || request.ExpectedPID != 42 || request.ExpectedWindow != 101 || request.InputVersion != "human-version" || request.Element.Value != "old" {
			t.Fatalf("focused write lost binding or changed legacy semantics: %+v", request)
		}
	}
}

func TestInvalidFocusNeverDispatches(t *testing.T) {
	for _, focus := range []any{"true", 1, nil} {
		s := newService()
		result := s.callTool("set_value", map[string]any{"app": "fixture", "element_index": "8", "value": "new", "focus": focus})
		if !result.IsError || s.bridge.cmd != nil {
			t.Fatal("invalid focus reached desktop", result)
		}
	}
}

func TestFormTextKeepsDecisionEvidenceWithoutMutatingStructuredScores(t *testing.T) {
	row := map[string]any{"element_index": "8", "name": "工作邮箱", "original_label": "工作邮箱", "current_value": "旧值", "matching_label": "Email", "label_source": "main_model_projection_bound_to_observation", "recommended_action": "fill", "recommended_value": "qa@example.test", "selected_option": "fill Email: qa@example.test", "probabilities": []any{0.98, 0.02}, "context_truncated": true, "truncated_options": []any{1}}
	full := map[string]any{"status": "scored", "execution": "local-coreml", "options": []any{"fill Email: qa@example.test", "skip"}, "recommendations": []any{row}}
	compact := formMatchingText(full)
	result := compact["recommendations"].([]any)[0].(map[string]any)
	for _, key := range []string{"element_index", "current_value", "matching_label", "label_source", "recommended_action", "recommended_value", "probabilities", "context_truncated", "truncated_options"} {
		a, _ := json.Marshal(result[key])
		b, _ := json.Marshal(row[key])
		if string(a) != string(b) {
			t.Fatal("decision evidence lost", key)
		}
	}
	if compact["options"] != nil || result["selected_option"] != nil || full["options"] == nil || row["selected_option"] == nil {
		t.Fatal("redundancy not removed or source mutated")
	}
}
