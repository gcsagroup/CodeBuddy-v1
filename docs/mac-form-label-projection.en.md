# Local FORMS label projection on Mac

[简体中文](mac-form-label-projection.zh-CN.md) · [繁體中文](mac-form-label-projection.zh-TW.md)

The main model translates observed field semantics into English scoring labels. FluidUse/CUA-S1-FORMS scores them locally; existing native tools execute the main model's selected actions. This adds no network model, input permission, or automatic submission.

The published small model depends heavily on its training vocabulary. Ablations found that even `Work email` skips where `Email` matches; form titles and existing values also affect results. Never erase existing values in the scoring input to force a fill recommendation. See the [model card](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md) and [training concepts](https://github.com/trycua/cua/blob/main/libs/cua-s1/python/src/cua_s1/concepts.py).

Observe the exact window first, then call `get_app_state` on the same selector with original `form_entities` and optional `form_labels`:

```json
{"app":"window:42:8","form_entities":[{"label":"公司","value":"海风测试"},{"label":"工作邮箱","value":"qa@example.test"}],"form_labels":{"title":"Customer Form","fields":[{"element_index":"18","label":"Company"},{"element_index":"23","label":"Email"}],"entities":["Company","Email"]}}
```

Indices are examples: copy those in the actual observation. `title` affects scoring only and defaults to the original title. `fields` lists only resolved target fields; unlisted controls skip without inference. Leave indistinguishable email fields unmapped. `entities` aligns with source order; labels must be distinct printable ASCII strings of at most 64 bytes. Do not collapse different recipients into indistinguishable options. Original labels, current values and replacement values remain intact. Receipts retain original and scoring labels, source values and real probabilities; unscored controls have no fabricated probabilities.

Go obtains native identities from its current snapshot; the model cannot supply native bindings. Swift validates the window, bounds and every named/value node and editable field's identity, name, value and geometry before inference. Anonymous, empty, noneditable decoration nodes are excluded from translation context: Safari can add/remove empty AXGroup nodes without changing the form. Unnamed/empty editable fields remain included, and target native paths must still match exactly. Changes to fields, nearby labels or drafts invalidate the projection. Failure degrades matching only and returns a fresh observation, without input or replay. Invalid optional projections do not silently fall back to raw-label scoring. Legacy calls without projections retain their behavior. No new persistent state is introduced.

The main model still owns semantic scope, ambiguity and action selection. A local skip is not a permission decision. Distinguish save-key dispatch, visible state and disk persistence. Tests cover real CoreML Chinese recommendations, preserved unlisted fields, stale bindings, alias collisions, legacy calls and index remapping. Product acceptance requires the current real-device evidence, separately from automated tests.
