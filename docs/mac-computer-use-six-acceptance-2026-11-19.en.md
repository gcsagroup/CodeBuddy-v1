# Mac Computer Use: six-part acceptance, 2026-11-19

[简体中文](mac-computer-use-six-acceptance-2026-11-19.zh-CN.md) · [繁體中文](mac-computer-use-six-acceptance-2026-11-19.zh-TW.md)

All six agreed acceptance areas passed on the fixtures and machine described here. This delivery is a running source preview, not a new DMG or a claim about every Mac application.

## Source and execution identity

Windows: `D:\CodeBuddy-v1`, main `4c8afad978b6e893a3545c0859dd5b4824a91223`, with existing and current uncommitted work preserved. No branch, commit or push was made. Mac: `/Users/erjinyi/Desktop/work/CodeBuddy-v1`, Git HEAD `732113504de3601ab087a609ce20827b814db2c2`, overlaid with the current Windows workspace. Every Windows source-inventory entry exists on Mac with the same newline-normalized SHA-256; local evidence, dependencies, caches and local reports are excluded. Additional Mac files and licenses remain untouched. The two Git HEADs are not identical.

Final runtime PID 29316 started `2026-11-19T02:54:24.016Z`. Source/current hash: `677e55481e4fa4e3a796f2720f7e8e76752d3073c7c28b4a4e5290ba9032a810`; restartRequired=false. Native binary SHA-256: `9e30cfdd6ffcbafa6160d5ee5e8f3fa21de8d3dfd3ee5db3b707c0b94d1e8f17`, built in `target/codebuddy-package/computer-arm64-sHYE7q`.

Machine: Apple M2, 16 GiB, macOS 27.0.1 (26A434), Swift 6.4.2. Actual GUI-launched control, input and capture succeeded. Screen-capture denial for an independently SSH-launched process is an environment limitation, not a product failure. Main model: Ollama `deepseek-v4.1-flash`, high effort. Local CoreML FORMS recommends values; API `CUA-S1-Qwen3.5-4B` only observes screenshots.

## Fixes

1. Descriptive requests were being converted into an exact immutable window caption. Schema and skill now distinguish descriptions from explicit exact-caption restrictions; discover real selectors first. The host binds scope on discovery and rejects later broadening, without language-specific intent rules.
2. Anonymous empty decorative AX groups caused false stale FORMS projections. Native context validation now excludes only empty noneditable decoration, retaining all named/valued nodes and every editable field, including unnamed empty ones. Window, identity, geometry, values and unique field binding still invalidate stale projections.
3. Losing a native receipt after a write could leave a model refresh waiting indefinitely on pause. The host now stops desktop control for that turn, reports the action as unknown, keeps independent non-desktop work available, and requires fresh observation after explicit continuation. It does not replay uncertain input or introduce another state protocol.

Changed areas: `runtime/desktop-coordinator.mjs` and tests; computer-use skill and tests; `tools/qwen-computer-use/main.go`; `macos/RuntimeContract.swift` and contract tests; projection documentation and ownership notes. Previously approved PDFKit disk observation and recognition improvements remain. See the [previous performance report](mac-forms-performance-2026-11-19.en.md).

## Six acceptance areas

| Area | Real result | Status |
|---|---|---|
| Mac baseline | Actual titles, fields, values, input and screenshots; real CoreML scoring and upstream sample | PASS |
| FORMS | Chinese recommendations and actual writes 2/2; ambiguous email fields preserved; unknown field reported | PASS |
| Conversation to native input | Visible CodeBuddy chat changed Preview; UI and saved PDF values agree | PASS |
| Drafts and interruptions | Preserved values; stale click rejected after Finder switch; popup cancelled; Esc and lost receipt stopped control; same-chat continuation observed first | PASS |
| Web and native apps | Official sample 3/3, 20 other items preserved, zero submissions; Preview saved original PDF | PASS |
| Comparison and delivery | Same model, effort and initial values; correctness, time and tokens recorded; runnable preview, fixtures and evidence delivered | PASS |

Chinese evidence: `cn-projection`, session `d2c2bbe1-6d06-4d0e-8c20-c7d80aa15fda`. Raw Chinese matching skipped; main-model English projection then bound the actual controls. Local Company→云杉测试 and Email→yunshan+forms@example.test recommendations were both fill, probabilities approximately 0.999157 and 0.999960, scoring approximately 18.818 and 2.898 ms. Unmapped billing and notes were neither scored nor changed.

| Scenario | Harness seconds | Result |
|---|---:|---|
| scope-cn / scope-description / scope-en | 29.980 / 33.839 / 42.582 | Three descriptive prompts each filled 2/2 |
| scope-exact / scope-missing | 26.106 / 10.748 | Exact caption works; missing exact caption produces zero input |
| ambiguous / unknown | 28.244 / 33.083 | Preserve indistinguishable emails; report missing customer-tier field |
| popup | 42.540 | Cancel modal without entering data there |
| escape-ui / escape-ui-resume | 40.227 / 32.758 | Visible UI Escape stops further input; same chat observes and fills only missing email |
| lost-fixed / lost-fixed-resume | 25.461 / 12.151 | Write occurred before receipt loss; unknown outcome, no hang; resume does not rewrite company |
| switch-timed | 40.108 | Finder foreground causes NOT dispatched; fresh observation precedes continuing in Safari |
| cn-projection | 33.422 | Genuine local recommendation and actual fill 2/2, no stale error |
| official | 36.731 | Nora, Lin and nora.lin+sample@example.test; 20 other values unchanged, zero submit |
| pdf-ui | 23.815 | One save, no recognition or shell, all four disk fields correct |
| vision | 17.323 | Real CUA literal four-field output, zero mutation calls, unchanged PDF hash |

Window trials used this batch's window fix. Two revealed the decorative-node projection problem and count only as window/fill checks, not successful FORMS matching. The rebuilt native runtime subsequently passed Chinese, English comparison and final PDF matching. Escape used that same final native binary. The host was then restarted after the disconnect fix; disconnect and all subsequent trials used final PID 29316. Earlier failures are not represented as proof of the later fix.

Fault injection terminates only the isolated native worker after the page's company input event and before its receipt; it is not a RustDesk disconnect. The first `lost` trial exposed the hang and remains a pre-fix failure. In `lost-fixed`, the company already had the intended value, but a complete real write and subsequent receipt loss were observed; resume did not rewrite it. `escape` had no visible UI keyboard listener and `switch` switched too late; both are excluded as invalid injection attempts. Valid replacements are `escape-ui` and `switch-timed`.

Final visible chat session: `ec0548c4-8a0e-4feb-9e29-15e33998d1f0`. Company was already 海风测试; only work email changed to haifeng+pdf@example.test. Billing remained billing-keep@example.test and notes remained 保留原备注：海风旧稿 001. A single super+s was followed by matching native PDFKit and independent disk values. The visible response and Preview form were both inspected.

## Honest performance comparison

Both new sessions began with identical empty company/work fields and identical existing billing/notes. Both produced 2 correct, 0 wrong, 0 missing, 0 submissions.

| Path | Harness seconds | Service round-trip seconds | Uncached input | Cache read | Output tokens |
|---|---:|---:|---:|---:|---:|
| Native controls only | 20.389 | 20.756 | 38,612 | 79,232 | 1,044 |
| Native + FORMS | 26.746 | 31.047 | 42,627 | 105,472 | 2,370 |

FORMS added approximately 6.36 seconds and 10.4% uncached input in this simple form. It provides inspectable matching evidence, not demonstrated overall speed or token savings here. This is one paired trial, not a latency distribution. Final PDF used 31,013 / 70,528 / 1,375 tokens and no extra screenshot/shell verification. Its different initial values prohibit a new speedup percentage against earlier trials. The earlier strict PDF 69.216→25.965-second pair and same-image recognition comparison remain in the previous report.

## Verification and reuse

All final commands exited 0:

- Windows and Mac Node 24: `--test runtime/tests/desktop-coordinator.test.mjs runtime/tests/desktop-control.test.mjs runtime/harness/test/computer-skill.test.mjs`, 38/38 each.
- Windows Node 24: `--test runtime/tests/session-lifecycle.test.mjs`, 19/19.
- Mac Go: gofmt, `go test ./...`, `go vet ./...` in `tools/qwen-computer-use`.
- Existing `buildMacComputer(root,'arm64',{test:true})`: Go and Swift contracts, real CoreML/PDF 8/8, release build. Existing macOS API deprecation warning remains; no build error.
- `python -X utf8 .local/mac-six-20261119/verify.py`: page events, genuine recommendations, interruption/resume, disk values, vision/hash and runtime/source assertions. An initial verifier typo used firstName/lastName instead of the upstream HTML's first/last IDs; the verifier was corrected, not the product result.
- Source inventory comparison and `git diff --check`. No Rust changes, Cargo run or installer build.

Running preview: `.local/fluiduse-20261118/launch-preview.command` → official `start-preview.sh`; isolated profile `.local/fluiduse-20261118/profile`. Evidence on both hosts: `.local/mac-six-20261119/`, including summary, verified assertions, session receipts, events, identity, source manifests, prompts and logs. Fixtures: `server.cjs` on port 56958, upstream sample HTML and `/tmp/codebuddy-speed-customer.pdf`; `start-server.py` starts the fixture after a restart.

Use `cases.json` for the tested Chinese, English, ambiguous and resume prompts. Final PDF prompt requests the open test PDF, Company 海风测试, work email haifeng+pdf@example.test, preservation of both other fields, verification and saving without submission. Fault injection is restricted to its isolated worker and must not be replayed against another session. Arbitrary forms, other macOS versions, Windows-wide product acceptance and release packaging are outside this PASS scope.
