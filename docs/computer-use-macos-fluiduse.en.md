# Local macOS form matching

A later batch on the same day updated native value-write focus checks and the development artifact. Earlier records below remain historical. See [Mac performance acceptance](mac-performance-2026-11-18.en.md) for the current artifact identity, 25 prompt-suite turns and unmet performance goals.

The host remaps the control tree and FORMS `element_index` values together so they identify the same observed control. Unbound recommendations become `unavailable` and are cleared instead of retaining potentially actionable stale indices.

macOS defaults to `view=fields`, retaining native element indices and readback without Windows write tokens. The raw receipt retains its screenshot. Explicit `view=full` requests use the existing CUA image-observation route when visual details are needed. Action after-states return to control-first observations.

[简体中文](computer-use-macos-fluiduse.zh-CN.md) · [繁體中文](computer-use-macos-fluiduse.zh-TW.md)

On macOS, `get_app_state` accepts optional `form_entities`, an array of user-provided `label` and `value` pairs. The existing Swift helper reads actual Accessibility controls and scores them locally with FluidUse FormSchema and FluidAudio CUA-S1-FORMS. Its receipt includes element indices, existing values, recommendations, scores, truncation and latency. The main model chooses actions. Existing native tools execute and read back their results.

Recommendations grant no authority to overwrite drafts or submit forms. Ambiguous fields and skip suggestions require the main model's task interpretation. The Chinese probe suggested skipping the company, work email and other fields. Improved Chinese matching accuracy remains unproven.

For unnamed PDF controls, the scoring layer reuses FluidUse's `nearbyLabel` with static text and geometry from the current observation. `matching_label` and `label_source=nearby_text_candidate` expose that inference. Original control names, indices and input identity remain unchanged. The main model must check surrounding text; a geometric candidate is not a confirmed Accessibility label.

After authorizing dependency downloads, prepare FluidUse at revision `b51f7adfbade197f0a9c802e34ba8a98cd4ecbc9` and FluidAudio `0.15.8`. Both code dependencies use Apache-2.0.

If no editable controls were observed, the result is `status=no_fields`, `execution=not_run`: no model is loaded or scored. Only actual scoring returns `scored`. Missing model caches and other matching errors return `unavailable`, preserving the window observation.

Preview's Accessibility title can include a page count absent from the capture API title. Native mapping checks process and geometry, using titles to disambiguate. Different titles require a unique geometry match; reading the control tree also verifies the reverse mapping. Ambiguous overlapping windows remain rejected, without application-specific or suffix rules. See [Apple kAXTitleAttribute](https://developer.apple.com/documentation/applicationservices/kaxtitleattribute).

```bash
cd tools/qwen-computer-use/macos
swift package --disable-keychain resolve
cd ../../..
corepack pnpm --dir ui/desktop run test:macos-native
node scripts/prepare-harness-macos-tools.cjs --arch arm64
runtime/tools/bin/qwen-computer-runtime --prepare-forms
bash ./start-preview.sh
```

`--disable-keychain` skips credential lookup for public dependencies. Normal builds use resolved dependencies. Model preparation explicitly downloads into the FluidAudio user cache. Ordinary observation loads only the local model, reporting unavailable matching while preserving the native observation when assets are absent.

Acceptance starts in a Mac CodeBuddy chat built from the same source. Keep the Ollama DeepSeek model and reasoning level fixed and reset every form before each comparison. Require correct company and work email values, verbatim preservation of billing email and notes, and zero submissions. Leave indistinguishable email fields untouched and identify omissions. Record actual FORMS suggestions, main-model choices and field readback. Cover Preview PDF, window changes, takeover, Esc and reconnection. Report SSH permission diagnostics separately from actual app-child results. Product acceptance requires same-build desktop evidence.

## Device acceptance, 2026-11-18

The existing Mac checkout received Windows `D:\CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223`, including uncommitted source. All 2,439 files matched after line-ending normalization. The Mac Git HEAD was not moved: the file inventory identifies the build source. Nothing was committed or pushed. Acceptance used the development application launched by `start-preview.sh`; no installer was produced or replaced.

Final SHA-256: `qwen-computer-use=05679fcdf6dac2a887da375b1d6781dd56aa39cfc279d459cd75ab97ddb05316`; `qwen-computer-runtime=dcd8867a193f1ee49d2e28ffc71c1888fd52bcca8b95634d9a2961283b69ab4d`. Actual task requests used Ollama `deepseek-v4.1-flash/high`; auxiliary title generation used separate `off` requests. Full visual observations invoked the `CUA-S1-Qwen3.5-4B` API.

| Scenario | Observed outcome |
| --- | --- |
| English baseline / FORMS | Same initial values, main model and effort; both 2/2 correct, zero wrong or missing, billing email and notes preserved, zero submissions; 33.024 s / 29.380 s |
| Local inference | Company recommended `Northwind Studio`, adopted and read back; Work email recommended skip, filled by the main model under the user instruction. All six scored receipts in the final conversation referenced the corresponding displayed controls |
| Preview PDF | Initiated in real CodeBuddy chat; two requested fields correct and old values preserved; saved disk values independently read through PDFKit |
| Escape | Subsequent action blocked, no further desktop calls that turn; a new message observed again and filled only the missing email before saving |
| Worker disconnect | Terminated the isolated test worker; host paused without replay; a new message obtained fresh controls before continuing |
| Human focus change | Stale input explicitly not dispatched; fresh state and refocusing preceded subsequent input |
| Chinese webpage | Company and work email 2/2 correct; old billing email and notes preserved throughout; zero submissions |
| Duplicate email labels | Only company filled; both emails and notes preserved; work email explicitly reported unfilled; zero submissions |

Passed: Mac Go `test ./...` and `vet ./...`, native contract, four real CoreML tests, 24 Mac build/packaging tests, and 12 Harness skill/vision-routing tests. Final evidence validation passed 16 checks covering source inventories, browser events, saved PDF values, post-interruption tool calls and index consistency. Local receipts and logs are under `.local/fluiduse-20261118/`, excluded from commits.

Limits: FORMS still recommended skipping every Chinese field in these runs. Correct Chinese filling came from the main model; no Chinese matching improvement is established. One English comparison does not establish a stable speedup. Acceptance covers these fixtures, this Mac and this build, not arbitrary applications or forms.

## 2026-11-18 supplemental acceptance of all six items

The earlier record did not cover the upstream Plan preview, unknown fields, modal interruption, or a complete write whose receipt was lost. It was insufficient to claim all six items complete. Supplemental results follow.

| Agreed item | Result |
| --- | --- |
| 1. Mac baseline | Passed. arm64, macOS 27.0.1, Swift 6.4.2; actual CodeBuddy child processes read window titles, fields and current values. The pinned FluidUse Demo loaded its model; Plan only observed 25 elements, scored 24 and produced 19 planned actions without executing or submitting |
| 2. Local matching | Integration and behavior passed. CoreML receipt indices bind to actual controls. The main model handles Chinese; ambiguous email fields stay unchanged. An unknown reference code remains REF-KEEP-721; an absent customer-grade field is explicitly reported unfilled, while the two available target fields are correct |
| 3. Chat to native input | Passed through Mac CodeBuddy with Ollama DeepSeek/high. Native readback agrees with visible results and browser events; Preview PDF control values and saved disk values were checked |
| 4. Drafts and interruption | Passed for preserved values, focus changes, Esc and a modal; no text is entered while the modal is active. After the company value is fully written, terminating the native worker loses its receipt: the task reports an unknown outcome and stops. A new message observes first and fills only email, without rewriting company |
| 5. Web and native apps | Passed. The pinned upstream sample has only a passive event logger appended. CodeBuddy fills first name, last name and email correctly in external Safari, preserving the other 20 fields/checks, with zero submission. The Chinese fillable PDF workflow in Preview also passed |
| 6. Comparison and delivery | Agreed measurements completed. Identical initial values and main model/high: baseline 33.024 seconds, FORMS 29.380 seconds, both 2/2 correct, zero wrong or omitted fields and zero submission. A working Mac development preview, reusable fixture generators, prompts and evidence remain available; no installer was produced |

The supplemental test exposed a reporting defect: the model described a completed company write as not written after its success receipt was lost. The post-execution pause error in `runtime/desktop-coordinator.mjs` now explicitly reports an unknown outcome and labels pre-action values as historical observations. Permissions, the pause state machine and native binaries are unchanged. The added regression and the full coordinator suite passed 31/31 on Windows and Mac using `node --test runtime/tests/desktop-coordinator.test.mjs`, exit code 0. After restarting the corrected runtime, real chat turn 6 accurately reported the unknown result; turn 7 observed first, filled email only, and verified 2/2 correct, preserved values and zero submission.

Local evidence is under `.local/fluiduse-20261118/supplement/`: 198 records in `session-evidence.json`, `events.jsonl`, `lost-receipt-fault.json`, eleven passed checks in `checks.json`, `upstream-plan.log`, `model-invocations.json`, and `build-identity.json`. Turn 4's partial-write injection and turn 5's pre-fix reporting defect are retained and excluded from the passing result. Final runtime source hash: `8372b5a78bf1a0140ff9f455113cdbf22defcc1f47f71aea3ed5e40fa11aa44e`, with no restart required. Native artifact hashes remain those recorded above. Unaffected native, matching and normal-path evidence is reused; interruption reporting and recovery use the corrected runtime's real tests.

The upstream Plan itself recommended a website for the message field and click for the submit button. Neither was executed in Plan only with submission disabled. Successful integration does not imply that every recommendation is correct, nor establish a Chinese matching improvement or stable speedup.
