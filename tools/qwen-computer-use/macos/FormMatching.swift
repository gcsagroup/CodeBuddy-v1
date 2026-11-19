import Foundation
import FluidUse
import FluidAudio

/// Scores observed fields only. Input authorization and execution remain with the host.
@MainActor
enum NativeFormMatching {
    private static var manager: CuaS1FormsManager?

    static func prepare() async throws {
        manager = try await CuaS1FormsManager.load()
    }

    private static func localManager() async throws -> CuaS1FormsManager {
        if let manager { return manager }
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw RuntimeFailure("The current user has no application support directory for the local FORMS model.")
        }
        let model = base.appendingPathComponent("FluidAudio/Models/cua-s1-forms/cua_s1_forms_fp16_options32.mlmodelc")
        guard FileManager.default.fileExists(atPath: model.path) else {
            throw RuntimeFailure("Local FORMS model is absent. Prepare it explicitly with qwen-computer-runtime --prepare-forms before requesting form_entities.")
        }
        let loaded = try await CuaS1FormsManager.load(from: model)
        manager = loaded
        return loaded
    }

    static func match(title: String, elements: [NativeElement], entities: [NativeFormEntity], labels: NativeFormLabels? = nil, bounds: WindowFrame? = nil) async throws -> [String: Any] {
        try validateFormEntities(entities)
        let projected = try labels.map { try validateFormLabels($0, title: title, bounds: bounds, elements: elements, entities: entities) }
        let scoringTitle = labels?.title ?? title
        let options = FormSchema.renderOptions(entities: entities.enumerated().map { index, entity in
            Entity(label: labels?.entities[index] ?? entity.label, value: entity.value)
        })
        let fields = elements.filter { ["AXTextField", "AXTextArea", "AXComboBox"].contains($0.controlType) }
        guard !fields.isEmpty else {
            return ["status": "no_fields", "model": "CUA-S1-FORMS", "execution": "not_run",
                "options": options, "recommendations": [],
                "notice": "No editable accessibility fields were observed; no model scoring occurred. Resolve the missing control evidence before filling."]
        }
        if projected?.isEmpty == true {
            return ["status": "no_mapped_fields", "model": "CUA-S1-FORMS", "execution": "not_run", "recommendations": [],
                "notice": "No unambiguous target fields were projected. Preserve unresolved fields; no scoring or input occurred."]
        }
        let model = try await localManager()
        let pageText = elements.compactMap { element -> (CGRect, String)? in
            guard element.controlType == "AXStaticText", let frame = element.frame else { return nil }
            return (frame.rect, element.value.isEmpty ? element.name : element.value)
        }
        var recommendations: [[String: Any]] = []
        for element in fields {
            // PDF controls often have no AX name. Reuse upstream's geometric
            // label candidate, but never promote it into native input identity.
            let originalLabel = element.name.isEmpty && element.frame != nil
                ? AccessibilityFormDriver.nearbyLabel(for: element.frame!.rect, role: "Edit", statics: pageText)
                : element.name
            if let projected, projected[element.index] == nil {
                recommendations.append(["element_index": String(element.index), "name": element.name, "current_value": element.value,
                    "matching_label": originalLabel, "recommended_action": "skip", "execution": "not_run", "reason": "not_projected"])
                continue
            }
            let matchingLabel = projected?[element.index] ?? originalLabel
            let field = FormElement(
                token: String(element.index), role: "Edit", label: matchingLabel, value: element.value,
                placeholder: "", checked: nil, frame: element.frame?.rect ?? .zero
            )
            let start = Date()
            let result = try await model.score(context: FormSchema.renderContext(formTitle: scoringTitle, element: field), options: options)
            let (action, entityIndex) = FormSchema.decode(optionIndex: result.selectedIndex, entityCount: entities.count)
            var row: [String: Any] = [
                "element_index": String(element.index), "name": element.name, "current_value": element.value,
                "matching_label": matchingLabel,
                "original_label": originalLabel, "execution": "local-coreml",
                "label_source": !element.name.isEmpty ? "accessibility_name" : matchingLabel.isEmpty ? "unavailable" : "nearby_text_candidate",
                "recommended_action": action.rawValue, "selected_option": result.selectedOption,
                "probabilities": result.probabilities, "context_truncated": result.contextWasTruncated,
                "truncated_options": result.truncatedOptionIndices,
                "elapsed_ms": Date().timeIntervalSince(start) * 1000
            ]
            if projected != nil { row["label_source"] = "main_model_projection_bound_to_observation" }
            if let entityIndex {
                row["entity_index"] = entityIndex
                row["recommended_value"] = entities[entityIndex].value
            }
            recommendations.append(row)
        }
        return ["status": "scored", "model": "CUA-S1-FORMS", "execution": "local-coreml",
            "source_title": title, "scoring_title": scoringTitle,
            "source_entities": entities.map { ["label": $0.label, "value": $0.value] },
            "options": options, "recommendations": recommendations,
            "notice": "Recommendations only. Check user scope, ambiguous labels, existing values and truncation before choosing an input. Never infer permission to submit from a model score."]
    }
}
