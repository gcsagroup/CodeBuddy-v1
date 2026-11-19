# Mac FORMS and PDF performance verification — 2026-11-19

[简体中文](mac-forms-performance-2026-11-19.zh-CN.md) · [繁體中文](mac-forms-performance-2026-11-19.zh-TW.md)

Later status: window targeting, takeover and disconnect issues were fixed and retested in the [six-part delivery acceptance](mac-computer-use-six-acceptance-2026-11-19.en.md). This page preserves historical candidates and failures, not the latest completion status.

Implemented and tested: observation-bound English scoring labels for Chinese FORMS fields, native read-only PDF disk receipts, and compact screenshot transcription. The paired PDF dialogue improved from 69.216 to 25.965 seconds with the same prompt, initial field values, main model and reasoning effort. This is scoped acceptance, not a claim that every Mac feature or all six historical workstreams were retested.

## Source and runtime

Windows source: `D:\CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223`, including existing and current dirty work. No branch, commit or push was created. Mac root: `/Users/erjinyi/Desktop/work/CodeBuddy-v1`; its Git HEAD remains `732113504de3601ab087a609ce20827b814db2c2`, so entire-checkout parity must not be claimed. Relevant current sources are independently hash-checked.

Final runtime PID 26736, started `2026-11-19T02:05:52.141Z`, source/current hash `d4fb5daa8fa4ca024beaae6406d397569bcab305127fb8f68cedc7da1f977811`. Native binary SHA-256: `1e7be4114091ce6e852bbb6c5f7fcf12cb3fce5e0c0c9c895836ba889571a881`. This is a running source preview, not a new DMG. Main model: Ollama `deepseek-v4.1-flash`, high; observer: configured `CUA-S1-Qwen3.5-4B`; FORMS: local CoreML.

## Mechanism and root cause

116 real-model ablations found that Chinese field labels, entity keys and form titles can induce skip; even English `Work email` can fail where `Email` succeeds. Existing values independently affect scoring. This agrees with the upstream limited-vocabulary [model card](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md) and [concept definitions](https://github.com/trycua/cua/blob/main/libs/cua-s1/python/src/cua_s1/concepts.py).

- Approved optional `form_labels`: the main model supplies scoring translations; Go binds them to observed controls; Swift validates window, geometry, controls, nearby labels and existing values before inference. Original values remain unchanged; unlisted fields are not scored. Legacy calls remain compatible. See [protocol](mac-form-label-projection.en.md).
- Custom provider IDs previously bypassed the CUA endpoint's no-thinking setting. Matching now uses the same configured endpoint/model, scoped to read-only screenshot interpretation. Main-model settings remain unchanged.
- Native observations expose AXDocument and verified foreground identity, and omit repetitive empty AX properties without losing indices or meaningful values.
- The separately approved [PDF disk receipt](mac-pdf-disk-observation.en.md) uses system PDFKit on the matched window's local AXDocument file. It distinguishes unsaved UI values from disk values, rejects unstable/unavailable reads, and never saves or submits automatically. No new dependency was added.

Changed areas: `runtime/providers.mjs`, `runtime/vision-routing.mjs`, desktop skill guidance, Go observation/form-matching code, native `runtime.swift`, `RuntimeContract.swift`, `FormMatching.swift`, new `PDFDiskObservation.swift`, package source list, regression tests and ownership documentation.

## Final candidate results

Times below are Harness turn durations. Input columns separate uncached input from cache reads; their sum is not a billing estimate. ACP trials use the running Mac CodeBuddy and real native desktop. The paired PDF trial was initiated in visible CodeBuddy chat.

| Scenario | Seconds | Uncached / cached / output tokens | Outcome |
|---|---:|---:|---|
| Restore two PDF fields to comparison baseline | 22.172 | 35,380 / 67,328 / 1,288 | Correct disk values, one save, no vision/shell |
| Identical PDF prompt in visible chat | 25.965 | 26,739 / 75,776 / 1,535 | 2/2 correct, other fields preserved, one save, no vision/shell |
| English prompt, change only work email | 23.618 | 40,302 / 82,432 / 1,534 | Correct, other three fields preserved, one save |
| Explicit screenshot transcription | 23.736 | 17,125 / 28,288 / 521 | Four fields correct; no input |
| Chinese web form | 23.665 | 47,106 / 133,888 / 2,053 | 2/2 real FORMS recommendations and writes; preserved drafts, zero submits |
| English web form | 22.148 | 31,150 / 89,728 / 1,039 | 2/2 correct; preserved drafts, zero submits |
| Generic target description, two identical email labels | 47.527 | 33,235 / 112,640 / 3,783 | Company only; both emails and notes preserved; zero submits; stale FORMS projection rejected |
| Read-only PDF inspection | 10.990 | 15,786 / 29,184 / 428 | No input tools; unchanged file hash |
| Missing exact target window | 13.655 | 16,081 / 26,112 / 865 | No input tools; unchanged file hash |

The paired old PDF trial took 69.216 seconds, 58,387 uncached / 128,384 cached / 2,885 output tokens, with 12 tool calls including vision and shell. The new trial used 8 calls. Observed reductions: 62.5% time, 54.2% uncached input, 46.8% output. This is one pair; tool choices, cache and service latency still vary. Native disk reads measured approximately 0.75–2.02 ms.

Same-image CUA comparison: 18.087 seconds and 132 output tokens before compact transcription; 9.164 / 9.129 seconds and 34 tokens after. Visible fields matched in all three. Final live four-field recognition took 11.167 seconds and 51 output tokens. No image downscaling or field truncation was introduced.

Chinese local recommendations were Company→海风测试 and Email→qa@example.test, approximately 0.999447 / 0.999953 probability, around 2–4 ms per field. Every web event was checked for preserved billing/notes and zero submissions; PDF fields were independently read from disk with PDFKit.

## Failures, boundaries and checks

All 15 relevant source hashes match the current Windows workspace. `python -X utf8 .local/mac-deep-20261119/verify-v2.py` exited 0, checking final source identity, every event in the three final web fixtures, three PDF save receipts and independent disk values, paired initial/final values, read-only hashes and four-field recognition. Final visible web values were also checked through RustDesk. Evidence is recorded in `verified-v2.json` and `pdf-disk-*` / `disk-readonly-*` files.

Final generic-description ambiguity session `9bad3e49-959f-45b4-b155-f3d34167438d` located the window and changed only company. Native validation rejected its stale FORMS projection; the main model preserved both ambiguous emails and explained the omission. This passes conservative fallback behavior, not FORMS scoring, and one successful retry does not prove a targeting mechanism fix.

Preserved failure: session `b9341ef2-8b54-4a4d-a375-c6d578ac1356` interpreted generic “customer form” as an exact window title and could not locate it. No writes occurred. An explicit-title ambiguity trial succeeded: company changed, both indistinguishable emails and notes preserved. That success does not prove the earlier window-language issue was fixed. FORMS can still reasonably skip populated fields; the main model owns authorized replacement semantics.

All applicable final commands exited 0: Node 24 vision-routing suites 20/20 on Windows and Mac; provider suite 46/46; computer-skill suite 4/4; Mac `go test ./...` and `go vet ./...`; existing `buildMacComputer(root,'arm64',{test:true})` wrapper with native contracts, Swift/CoreML/PDF tests 8/8 and release build; evidence assertions and `git diff --check`. Default Windows Python decoding initially rejected UTF-8 JSON; `python -X utf8` passed. It was an evidence-reader environment error, not a product failure.

Evidence: `.local/mac-deep-20261119/`, including runtime/source identities, raw sessions, `final-sessions.json`, web events, PDF before/after values, unchanged read-only hashes, ablations and test logs. No installer release, whole-Windows product E2E, or full takeover/disconnection suite was performed in this batch. Earlier intermediate results remain in the Simplified Chinese report and raw records; failures were not relabeled as passes.
