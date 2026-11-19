# macOS edited-state experiment: reverted

[简体中文](macos-document-state.zh-CN.md) · [繁體中文](macos-document-state.zh-TW.md)

The 2026-11-19 experiment was not retained. Preview did not support window-level `AXEdited`. Reading its own close button returned `false` before editing, after editing and after saving the sample PDF. That did not establish the required state transition. The native sources and running helper were restored to their pre-experiment versions.

The proposed interpretation was true = application reports unsaved changes, false = application reports none, unknown = missing, unreadable or malformed attribute. These are experimental semantics, not a delivered product contract. A false flag never independently proves disk contents, synchronization, correctness or permission to save.

The prototype used [Apple's AXEdited attribute](https://developer.apple.com/documentation/applicationservices/kaxeditedattribute?language=objc), accepted only CFBoolean, and passed native contract tests. Real application behavior nevertheless failed acceptance; compilation and unit tests cannot substitute for it.

Window-only trial `after-pdf-1`: 39.156 seconds / 103,595 input tokens. Close-button trial `after-pdf-2`: 82.184 seconds / 371,010 input tokens, including extra disk searches by the main model. Final PDF contents were correct, but the performance objective failed. Local evidence is under `.local/mac-speed-20261119/`. Input tokens include cache reads and are not a billing estimate. See this batch's performance report for the separate prompt-deduplication result.
