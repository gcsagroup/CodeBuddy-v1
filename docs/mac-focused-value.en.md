# Focused single-field writes on Mac

[简体中文](mac-focused-value.zh-CN.md) · [繁體中文](mac-focused-value.zh-TW.md)

The optional boolean `focus` parameter on Mac `set_value` was approved on 2026-11-19. The main model still selects an observed field and value. With focus=true, one native call focuses that exact field, validates again and writes, removing a separate click and model round trip. This is neither batch filling nor automatic field selection.

The native executor checks window/field bindings, lease and value writability, optionally sets AXFocused, then revalidates the current window, original element identity/value/geometry, actual focus and human-input version before writing and returning fresh evidence. Focus can trigger application handlers, so the second validation is mandatory. Failure stops with no guessed coordinates, keyboard fallback or replay. A dispatched focus operation can itself have effects and remains an uncertain action if later checks fail.

Omission/false preserves legacy behavior: web fields must already have verified focus; native PDF writes retain existing rules. Windows neither advertises nor accepts the parameter. No persistence or host Escape, queue, disconnect or resume semantics change.

Prefer `focus=true` for web fields; omit it for native document fields such as Preview PDF fields. Live testing found that Preview can return AX error -25200 despite advertising AXFocused as writable. Direct native value replacement therefore should not add an unnecessary focus operation.

Uses system [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue) and [focus attributes](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/attributes), reusing existing identity, foreground, input-version and lease checks without dependencies. Separate click→model→set_value remains available. Whole-form execution was rejected because it would remove per-field decisions and interruption observation points.

FORMS remains advisory. Text receipts omit repeated candidate entities and the selected_option already decomposed into action/value; complete structured scores remain intact. Exact recommendations, current values, label provenance, probabilities and truncation warnings stay visible. Local scoring duration is not end-to-end duration.
