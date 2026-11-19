package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func TestFormEntitiesPreserveUserValuesAndRejectMalformedInput(t *testing.T) {
	input := []map[string]any{{"label": "工作邮箱", "value": "qa@example.test"}, {"label": "公司", "value": " 海风测试 "}}
	entities, err := parseFormEntities(input)
	if err != nil || entities[1].Value != " 海风测试 " {
		t.Fatalf("changed source value: %v %v", entities, err)
	}
	for _, invalid := range []any{nil, "email", []any{}, []any{nil}, []any{map[string]any{"label": "邮箱", "value": 123}},
		[]formEntity{{Label: " ", Value: "x"}}, []formEntity{{Label: "Email", Value: ""}},
		make([]formEntity, 30), []formEntity{{Label: "Email", Value: strings.Repeat("x", 16385)}}} {
		if _, err := parseFormEntities(invalid); err == nil {
			t.Fatalf("accepted invalid entities: %T", invalid)
		}
	}
}

func TestFormMatchingReceiptPreservesScoringEvidence(t *testing.T) {
	var snapshot appSnapshot
	err := json.Unmarshal([]byte(`{"app":{"name":"Preview","pid":42},"windowHandle":8,"screenshotPngBase64":"cGl4ZWw=","formMatching":{"status":"scored","model":"CUA-S1-FORMS","recommendations":[{"element_index":"2","recommended_value":"qa@example.test"}]}}`), &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	result := snapshot.result()
	observation := result.StructuredContent["desktop_observation"].(map[string]any)
	matching := observation["form_matching"].(map[string]any)
	if matching["status"] != "scored" || !strings.Contains(result.Content[0].Text, "qa@example.test") {
		t.Fatalf("lost model evidence: %v", result)
	}
	if snapshot.FormMatching["actionDispatched"] != nil {
		t.Fatal("recommendation became execution")
	}
}

func TestNativeControlViewPreservesTreeAndRecommendationsWithoutWindowsWriteTokens(t *testing.T) {
	snapshot := appSnapshot{
		App: appDescriptor{Name: "Preview", PID: 42}, WindowHandle: 8,
		ScreenshotPNGBase64: "cGl4ZWw=", fieldView: true,
		TreeLines:    []string{`7 AXTextField "工作邮箱" value="old@example.test"`},
		FormMatching: map[string]any{"status": "scored"},
	}
	service := newService()
	defer service.close()
	accepted, result := service.acceptSnapshotResponse("window:42:8", psRequest{Tool: "get_app_state", controlView: true}, psResponse{OK: true, Snapshot: &snapshot})
	if result.IsError || accepted.fieldCapture != "" {
		t.Fatal("native control view incorrectly created Windows write tokens")
	}
	observation := result.StructuredContent["desktop_observation"].(map[string]any)
	if observation["view"] != "fields" || observation["form_matching"] == nil {
		t.Fatal("native control-first receipt lost its view or local recommendations")
	}
	if !strings.Contains(result.Content[0].Text, "old@example.test") || strings.Contains(result.Content[0].Text, "No eligible fields") {
		t.Fatal("native readback was lost or incorrectly subjected to Windows write-token rules")
	}
	if len(result.Content) != 2 || result.Content[1].Type != "image" {
		t.Fatal("host needs the original image receipt for explicit full-view inspection")
	}
}

func TestFormRecommendationsFollowDisplayedIndicesAcrossObservations(t *testing.T) {
	s := newService()
	defer s.close()
	s.nextElementIndex = 60
	for _, nativeIndex := range []int{15, 7} {
		var snapshot appSnapshot
		payload := `{"app":{"name":"Safari","pid":42},"windowHandle":8,"elements":[{"index":` + strconv.Itoa(nativeIndex) + `,"runtimeId":[1,2],"name":"Work email","controlType":"AXTextField"}],"treeLines":["` + strconv.Itoa(nativeIndex) + ` AXTextField Work email"],"formMatching":{"status":"scored","execution":"local-coreml","recommendations":[{"element_index":"` + strconv.Itoa(nativeIndex) + `","matching_label":"Work email","recommended_action":"fill","recommended_value":"qa@example.test","probabilities":[0.99,0.01]}]}}`
		if err := json.Unmarshal([]byte(payload), &snapshot); err != nil {
			t.Fatal(err)
		}
		accepted, result := s.acceptSnapshotResponse("window:42:8", psRequest{Tool: "get_app_state", controlView: true}, psResponse{OK: true, Snapshot: &snapshot})
		if result.IsError {
			t.Fatal(result)
		}
		row := accepted.FormMatching["recommendations"].([]any)[0].(map[string]any)
		index := row["element_index"].(string)
		field, err := lookupElement(accepted, index)
		if err != nil || field.Name != "Work email" || index != "60" || !strings.HasPrefix(accepted.TreeLines[0], index+" ") {
			t.Fatalf("recommendation no longer identifies the displayed field: %v %v", row, err)
		}
		if row["recommended_value"] != "qa@example.test" || len(row["probabilities"].([]any)) != 2 {
			t.Fatal("index remapping altered scoring evidence")
		}
	}
}

func TestUnboundFormRecommendationCannotReuseAnActionableIndex(t *testing.T) {
	matching := map[string]any{"status": "scored", "recommendations": []any{map[string]any{"element_index": "15", "recommended_action": "fill"}}}
	remapFormRecommendations(matching, map[int]int{7: 15})
	if matching["status"] != "unavailable" || len(matching["recommendations"].([]any)) != 0 {
		t.Fatal("unbound recommendation could retarget another field")
	}
}
