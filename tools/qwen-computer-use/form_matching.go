package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type formEntity struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// Keep the complete scorer result in structuredContent. The model-facing text
// need not repeat every candidate value or the selected action in three forms.
func formMatchingText(matching map[string]any) map[string]any {
	if matching["status"] != "scored" {
		return matching
	}
	compact := make(map[string]any, len(matching))
	for key, value := range matching {
		if key != "options" && key != "source_entities" {
			compact[key] = value
		}
	}
	rows, ok := matching["recommendations"].([]any)
	if !ok {
		return matching
	}
	result := make([]any, 0, len(rows))
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			return matching
		}
		copy := make(map[string]any, len(row))
		for key, value := range row {
			if key == "selected_option" && row["recommended_action"] != nil {
				continue
			}
			if label, ok := value.(string); key == "original_label" && ok && label == row["name"] {
				continue
			}
			copy[key] = value
		}
		result = append(result, copy)
	}
	compact["recommendations"] = result
	return compact
}

type formFieldLabel struct {
	Element elementRecord `json:"element"`
	Label   string        `json:"label"`
}

// Native bindings come from the current observation, never from model arguments.
type formLabels struct {
	Title            *string          `json:"title,omitempty"`
	Fields           []formFieldLabel `json:"fields"`
	Entities         []string         `json:"entities"`
	ObservedElements []elementRecord  `json:"observedElements"`
	ObservedTitle    string           `json:"observedTitle"`
	ObservedBounds   *frame           `json:"observedBounds"`
}

func scoringLabel(label string) bool {
	if strings.TrimSpace(label) == "" || len(label) > 64 {
		return false
	}
	for _, c := range label {
		if c < 32 || c > 126 {
			return false
		}
	}
	return true
}

func bindFormLabels(value any, prior *appSnapshot, entities []formEntity) (*formLabels, error) {
	if prior == nil || prior.WindowHandle == 0 || prior.App.PID <= 0 || prior.WindowBounds == nil || len(prior.Elements) == 0 {
		return nil, fmt.Errorf("form_labels requires a fresh observation of the exact window selector; observe first")
	}
	var input struct {
		Title  *string `json:"title"`
		Fields []struct {
			Index string `json:"element_index"`
			Label string `json:"label"`
		} `json:"fields"`
		Entities []string `json:"entities"`
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(encoded, &input); err != nil {
		return nil, fmt.Errorf("invalid form_labels: %w", err)
	}
	if len(entities) == 0 || len(input.Entities) != len(entities) || input.Fields == nil || len(input.Fields) > 400 {
		return nil, fmt.Errorf("form_labels needs fields and one English entity label per form_entities entry, in the same order")
	}
	if input.Title != nil && !scoringLabel(*input.Title) {
		return nil, fmt.Errorf("form_labels title must be 1–64 printable ASCII characters")
	}
	seenLabels := map[string]bool{}
	for _, label := range input.Entities {
		key := strings.ToLower(strings.TrimSpace(label))
		if !scoringLabel(label) || seenLabels[key] {
			return nil, fmt.Errorf("entity scoring labels must be nonempty, distinct English labels (at most 64 ASCII bytes); do not collapse different recipients into one label")
		}
		seenLabels[key] = true
	}
	result := &formLabels{Title: input.Title, Fields: []formFieldLabel{}, Entities: input.Entities,
		ObservedElements: prior.Elements, ObservedTitle: prior.WindowTitle, ObservedBounds: prior.WindowBounds}
	seenFields := map[int]bool{}
	for _, label := range input.Fields {
		element, err := lookupElement(prior, label.Index)
		if err != nil {
			return nil, err
		}
		if !scoringLabel(label.Label) || seenFields[element.Index] ||
			(element.ControlType != "AXTextField" && element.ControlType != "AXTextArea" && element.ControlType != "AXComboBox") {
			return nil, fmt.Errorf("field scoring labels require distinct observed editable indices and 1–64 ASCII characters")
		}
		seenFields[element.Index] = true
		result.Fields = append(result.Fields, formFieldLabel{Element: *element, Label: label.Label})
	}
	return result, nil
}

func formLabelsSchema() map[string]any {
	fields := map[string]any{"type": "array", "maxItems": 400, "items": objectSchema(map[string]any{
		"element_index": stringProperty("Exact editable index from the preceding observation of this same window"),
		"label":         stringProperty("English scoring label, e.g. Company, Email or Full name. Omit ambiguous or unrelated fields from this list; do not discard recipient distinctions."),
	}, []string{"element_index", "label"})}
	return map[string]any{"type": "object", "description": "macOS optional semantic label projection for local FORMS. Observe first, then translate only resolved target fields. The host binds translations to that observation and rejects changed controls/labels/values. Unlisted fields are skipped without scoring. Exact original values are never translated or cleared. This is a scoring suggestion, not permission or input. Omit to retain legacy raw-label scoring.",
		"properties": map[string]any{
			"title":    stringProperty("Optional English form title, at most 64 ASCII characters; scoring only, not a window selector"),
			"fields":   fields,
			"entities": map[string]any{"type": "array", "minItems": 1, "maxItems": 29, "items": stringProperty("English entity label in the same order as form_entities, e.g. Company, Email or Name. Labels must remain distinct.")},
		}, "required": []string{"fields", "entities"}}
}

// Recommendations and the displayed tree must reference the same observed controls.
func remapFormRecommendations(matching map[string]any, indices map[int]int) {
	if matching == nil || matching["status"] != "scored" {
		return
	}
	rows, valid := matching["recommendations"].([]any)
	if valid {
		for _, item := range rows {
			row, ok := item.(map[string]any)
			if !ok {
				valid = false
				break
			}
			text, ok := row["element_index"].(string)
			nativeIndex, err := strconv.Atoi(text)
			index, exists := indices[nativeIndex]
			if !ok || err != nil || !exists {
				valid = false
				break
			}
			row["element_index"] = strconv.Itoa(index)
		}
	}
	if !valid {
		matching["status"] = "unavailable"
		matching["recommendations"] = []any{}
		matching["notice"] = "Local FORMS recommendations could not be bound to the observed controls. Observe again before using field recommendations."
	}
}

func parseFormEntities(value any) ([]formEntity, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var entities []formEntity
	if err := json.Unmarshal(encoded, &entities); err != nil {
		return nil, fmt.Errorf("form_entities must be an array of label/value objects: %w", err)
	}
	if len(entities) == 0 || len(entities) > 29 {
		return nil, fmt.Errorf("form_entities requires 1–29 entries")
	}
	for _, entity := range entities {
		if strings.TrimSpace(entity.Label) == "" || entity.Value == "" || len(entity.Label) > 4096 || len(entity.Value) > 16384 {
			return nil, fmt.Errorf("form_entities requires nonempty labels and values, at most 4096 and 16384 UTF-8 bytes respectively")
		}
	}
	return entities, nil
}

func formEntitiesSchema() map[string]any {
	return map[string]any{
		"type": "array", "minItems": 1, "maxItems": 29,
		"description": "macOS only. User-provided labeled values for optional local FluidUse FORMS matching against this window's real controls. Returns recommendations only, with model scores and current values. Preserve user-provided values exactly. The main model must resolve user scope, ambiguity and existing drafts before executing input. Omit for ordinary observation.",
		"items": objectSchema(map[string]any{
			"label": stringProperty("Meaning of this user-provided value"),
			"value": stringProperty("Exact value provided by the user"),
		}, []string{"label", "value"}),
	}
}
