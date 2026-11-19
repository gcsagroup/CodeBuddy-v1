# Mac FORMS round-trip optimization and acceptance — 2026-11-19

[简体中文](mac-forms-roundtrips-2026-11-19.zh-CN.md) · [繁體中文](mac-forms-roundtrips-2026-11-19.zh-TW.md)

Implemented native focused single-field writes and deduplicated FORMS text receipts; verified against real Mac applications. Each final case used two fewer tool calls. Aggregate input tokens including cache fell 31.19%, and tool execution time fell 33.35%. **Mean end-to-end latency did not improve materially: Harness 24.489→24.476 s; ACP including waiting outside the turn 25.860→28.837 s, 11.51% worse. This is not a claim of universal acceleration.**

All three final cases filled 2/2 targets, with zero wrong/missing fields, preserved billing email and notes, and zero submissions. The [previous six-part report](mac-computer-use-six-acceptance-2026-11-19.en.md) defines the broader scope. This batch retests affected paths; previous official demo-page evidence is not represented as a rerun on the new binary.

## Cause and changes

The previous matched run without/with FORMS took 20.389/26.746 s, while summed tool execution increased only about 0.405 s (2.439/2.844 s). The two projected fields took approximately 6.27/1.96 ms locally. Additional model rounds, context and waiting outside turns dominate, rather than multi-second local field scoring.

- User-approved optional `set_value(focus=true)` focuses an observed field, then rechecks window, identity, old value, geometry, actual focus, human-input version and lease before writing and reading back. It replaces the separate click round, retains per-field decisions and provides no automatic coordinate/keyboard fallback. Omission preserves legacy behavior. See the [contract](mac-focused-value.en.md).
- Text receipts omit repeated candidates, already decomposed selected_option and duplicate labels; full structured scores remain unchanged. Exact recommended/current values, indices, provenance, probabilities, truncation and errors remain available.
- An intermediate English run mistook local FORMS for a workspace file, causing extra searches/glob. The skill now identifies the matcher as built into get_app_state. Final English had no irrelevant file calls; user test prompts and the global tool selector were unchanged.
- Preview can advertise AXFocused as writable yet return -25200. The final skill prefers focus=true for web fields and legacy direct writes for native PDF fields. No automatic native fallback was introduced.

Changed files: `tools/qwen-computer-use/{main.go,form_matching.go,focused_value_test.go}`, `macos/{RuntimeContract.swift,runtime.swift,contract-tests.swift}`, `runtime/harness/skills/computer-use/SKILL.md`, the fact-ownership map and trilingual documentation. Unrelated dirty changes were preserved.

## Matched comparisons

Same Mac, external Safari, fixture and initial values; exactly identical prompts within each pair. Every request/header confirms Ollama deepseek-v4.1-flash with high reasoning effort. Company/work email initially empty; billing billing-keep@example.test; notes `旧备注逐字保留 731：先核对，后提交。`. Runs use the running Mac CodeBuddy ACP conversation and real native tools, with RustDesk visual verification. Esc/PDF additionally start in visible CodeBuddy chat.

| Prompt | Harness seconds, before→final | ACP seconds | Calls | Uncached input | Cache reads | Output |
|---|---:|---:|---:|---:|---:|---:|
| Explicit Chinese | 27.780→38.655 | 28.181→48.827 | 9→7 | 43,543→24,842 | 104,192→77,952 | 1,390→1,175 |
| English | 23.157→15.585 | 24.583→18.063 | 8→6 | 31,535→25,546 | 89,088→55,168 | 952→869 |
| Conversational Chinese | 22.530→19.187 | 24.816→19.621 | 9→7 | 43,659→24,292 | 99,328→75,264 | 1,700→1,641 |

Totals: calls 26→20; receipt characters -19.60%; uncached input -37.10%; cache reads -28.78%; output -8.83%. Combined input tokens are not billing cost. There is one matched pair per prompt, not a stability distribution or statistical significance claim.

Final Chinese spent only 2.448 s in tools, but model steps included waits of 7.852 and 10.869 s, with ACP another 10.172 s longer than the Harness turn. Logs localize waiting but do not establish a provider-internal cause. English and conversational Chinese improved; the slower Chinese run canceled the aggregate latency gain and is retained. Chinese projected Company/Email recommendations succeeded. English Work email still scored skip; the main model filled it from explicit user/field evidence, not two successful FORMS recommendations.

Evidence is in `.local/mac-forms-speed2-20261119/`: cases/summary/metrics, sessions, event logs and verified.json. Final sessions: `820b5654-d559-4f2e-a45a-a3ed55ebb542`, `e7ae4fcb-10be-4b8c-a01c-abdff649d02c`, `6be5ebfe-705e-4649-bf2c-fd67964137cf`.

## Protection and saving

- A focus-triggered modal invalidated the field; native revalidation prevented writes. Company/email and modal text remained unchanged. The operator dismissed the fixture modal only after the turn ended.
- Identical email labels: only company changed; both email values and notes stayed unchanged, with ambiguity explained.
- Receipt loss: the bound test native worker was terminated after a real company input event. DESKTOP_STOPPED reported an unknown outcome; work email stayed empty and no automatic replay occurred. Same-chat resume reobserved and filled only work email.
- Real Esc in visible CodeBuddy chat: no input events between takeover and a new resume turn. Resume reobserved and filled only email, preserving REF-KEEP-721 and other old values, with no submission.
- Visible Preview PDF chat: one legacy set_value and one save; independent PDFKit disk readback and visible UI confirmed haifeng+verified@example.test and the three retained fields.

The disconnection test terminates a native worker between input and receipt; it does not prove behavior for every RustDesk/network outage. Protection cases and final comparisons use the same native binary; the last skill edit only changes PDF call selection.

Final PDF session `f46940ba-512f-4d8e-9d57-d6aa31a537e7` took 52.687 s and 11 calls, including an incomplete-window-selector rejection, one vision observation and an extra observation after save. **Functionality and persisted content passed; PDF speed improvement did not.** Native disk read took about 0.811 ms, not the entire task. The first PDF attempt failed focusing, was later interrupted by operator Esc and did not save; it is retained as a failed/interrupted case. Intermediate comparison times 26.792/36.980/23.195 s are also retained.

## Source, checks and delivery

Windows source: `D:\CodeBuddy-v1`, main@4c8afad978b6e893a3545c0859dd5b4824a91223 plus existing/new dirty changes. Mac: `/Users/erjinyi/Desktop/work/CodeBuddy-v1`, HEAD 732113504de3601ab087a609ce20827b814db2c2 with the current Windows source overlay. Normalized file-hash inventories verify parity; different Git HEADs alone are not equivalent source identities.

Runtime PID31533 started 2026-11-19T04:01:06.499Z; source/current hash 677e55481e4fa4e3a796f2720f7e8e76752d3073c7c28b4a4e5290ba9032a810, restartRequired=false. Native SHA256 fad15ef85ce0d3eda9d55834bff34ad3cacb233ebaf8ab52ba8cd692326dda29; final skill SHA256 43d56e37f49d44e16ddc7b61504213f1f2efe0c479d8c920e8277564744b0d6d. These separate hashes matter because the runtime hash does not include every native/skill file.

Effective commands exited zero: Node24 `--test runtime/harness/test/computer-skill.test.mjs runtime/tests/desktop-coordinator.test.mjs runtime/tests/desktop-control.test.mjs` 38/38 on each host, final skill4/4 each; Mac go test ./..., go vet ./... and gofmt; existing build.cjs/buildMacComputer wrapper with Swift contracts, real CoreML/PDF8/8 and production build; verify.py assertions for nine paired/intermediate event streams, model/effort, protection/resume and persisted PDF; relevant git diff --check. Existing activateIgnoringOtherApps deprecation warning remains. No Rust changes or Cargo/Clippy run; no Windows product E2E this batch.

Delivered as a running Mac source preview, not a new DMG. No commit/push or new dependencies. Test services/pages are closed after evidence collection; preview and evidence remain. Model/outside-turn waiting and some redundant observations remain performance limitations. Reasoning effort and safety checks were not reduced to improve numbers.
