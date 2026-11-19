package main

import (
	"bufio"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestFormLabelsBindObservedIndicesAndRetainOriginalEvidence(t *testing.T) {
	prior := &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: 8, WindowTitle: "客户表单", WindowBounds: &frame{Width: 600, Height: 400},
		Elements: []elementRecord{{Index: 60, RuntimeID: []int{0, 1}, Name: "公司", ControlType: "AXTextField", Value: "旧值"}, {Index: 61, RuntimeID: []int{0, 2}, Name: "邮箱", ControlType: "AXTextField"}}}
	entities := []formEntity{{Label: "公司", Value: " 海风测试🙂 "}}
	input := map[string]any{"title": "Customer Form", "fields": []map[string]any{{"element_index": "60", "label": "Company"}}, "entities": []string{"Company"}}
	labels, err := bindFormLabels(input, prior, entities)
	if err != nil || labels.Fields[0].Element.RuntimeID[1] != 1 || labels.Fields[0].Element.Value != "旧值" || labels.Fields[0].Element.Name != "公司" || len(labels.ObservedElements) != 2 || entities[0].Value != " 海风测试🙂 " {
		t.Fatalf("projection changed observed identity or source values: %#v %v", labels, err)
	}
	for _, bad := range []any{nil, map[string]any{"fields": []any{}, "entities": []string{}},
		map[string]any{"fields": []map[string]any{{"element_index": "59", "label": "Company"}}, "entities": []string{"Company"}},
		map[string]any{"fields": []map[string]any{{"element_index": "60", "label": "公司"}}, "entities": []string{"Company"}},
		map[string]any{"fields": []map[string]any{{"element_index": "60", "label": "Company"}, {"element_index": "60", "label": "Company"}}, "entities": []string{"Company"}}} {
		if _, err := bindFormLabels(bad, prior, entities); err == nil {
			t.Fatalf("accepted invalid labels: %v", bad)
		}
	}
	if _, err := bindFormLabels(input, nil, entities); err == nil {
		t.Fatal("accepted an unobserved projection")
	}
	input["entities"] = []string{"Email", "email"}
	if _, err := bindFormLabels(input, prior, []formEntity{{Label: "工作邮箱", Value: "work@example.test"}, {Label: "账单邮箱", Value: "billing@example.test"}}); err == nil {
		t.Fatal("different recipient values collapsed into indistinguishable scoring options")
	}
}

func TestInvalidOptionalFormLabelsReturnFreshObservationWithoutRawScoring(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("framed native bridge")
	}
	svc := newService()
	after := &appSnapshot{App: appDescriptor{PID: 42}, WindowHandle: 8, ScreenshotPNGBase64: "cGl4ZWw=", TreeLines: []string{"7 AXTextField 工作邮箱 value=old@example.test"}}
	wire, _ := json.Marshal(psResponse{OK: true, Snapshot: after})
	input := &recordedTextInput{}
	svc.bridge.cmd = &exec.Cmd{}
	svc.bridge.in = input
	svc.bridge.out = bufio.NewReader(strings.NewReader(string(wire) + "\n"))
	result := svc.getAppStateWithLabels("window:42:8", true, []formEntity{{Label: "工作邮箱", Value: "qa@example.test"}}, map[string]any{}, true)
	var request psRequest
	if err := json.Unmarshal(input.Bytes(), &request); err != nil {
		t.Fatal(err)
	}
	if result.IsError || !strings.Contains(result.Content[0].Text, "old@example.test") || !strings.Contains(result.Content[0].Text, "not_run") || request.FormLabels != nil || request.FormEntities != nil {
		t.Fatalf("optional projection failure hid observation or ran unrequested raw scoring: %#v %#v", result, request)
	}
	svc.bridge.cmd = nil
	svc.close()
}
