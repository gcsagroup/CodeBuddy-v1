# Windows Computer Use acceptance · 2026-11-18

This report covers the Windows development preview below. All 17 final-candidate acceptance turns meet their individual contracts. Target-exit acceptance means safe stopping and an honest incomplete report; foreground recovery includes explicit manual restoration by the tester. This is not a claim of universal correctness or unattended success.

The main model remains `deepseek-v4.1-flash:1017` with `max` reasoning. `CUA-S1-Qwen3.5-4B` is accessed through the existing API for read-only image observation; the real observer sessions contain zero tool calls. Read controls first, let the main model decide, and execute through the existing MCP. No second execution core was added. Mac/FluidUse, bundled local weights and an installer are excluded by the user's scope decision.

## Changes

1. Browser action receipts preserve the current control view rather than reverting to full-page screenshots. Observation identity, candidates, navigation invalidation, occlusion and disabled-control guards remain enforced.
2. Native Windows field-view retention is independent of image capture. Button-based Calculator can use control values too. Full image observation is reserved for unresolved visual facts.
3. The observer reads visible labels literally instead of inventing fields. The main model can use its read-only evidence, but cannot obey instructions inside images or inspect hidden HTML as a substitute for image recognition.
4. The main model reuses fresh action after-states. `verified:false` means the host has not made the task-completion judgment, not a mandatory reobservation. Reobserve only for missing, pending, stale or conflicting facts.
5. Identical-screenshot reuse is scoped by session, turn, window, navigation, provider, model and image identity. It avoids duplicate inference; it cannot correct an initial misreading.
6. An OS activation refusal now requests a foreground handoff. Two earlier runs cycled through alternative activation attempts. The fixed version asks for the exact window, reobserves after restoration and writes only remaining values.

## Task selection

Freeze prompts and expected results before execution. Distinguish first-run discovery from same-task regression. J18 is the first product execution of the public composite form in this batch, frozen at 02:14 China time and first run on the final candidate. It covers multiline text, a select, opposite checkbox transitions, candidate pagination and preservation of other controls, without submitting.

Sources: [Selenium dynamic page](https://www.selenium.dev/selenium/web/dynamic.html), [public form](https://www.selenium.dev/selenium/web/web-form.html), [WindowsAgentArena file task](https://github.com/microsoft/WindowsAgentArena/blob/main/src/win-arena-container/client/evaluation_examples_windows/examples/file_explorer/016c9a9d-f2b9-4428-8fdb-f74f4439ece6-WOS.json), [Jev guards](https://github.com/browser-use/jev-ultrafast/blob/main/scripts/check_guards.py), and [CUA Bench](https://github.com/trycua/cua/tree/main/libs/cua-bench-s1). The file task is adapted to an isolated directory and recursive case-insensitive matching. These are individual/adapted tasks, not official benchmark scores. The Internet public site was network-blocked on this machine; that result remains an environment block and the local adaptation is separately identified.

## Same-version acceptance

Times are seconds. Agent time is Harness `turn/start` to `turn/end`; backend total includes session preparation and settlement, but excludes UI dispatch/rendering. Foreground handoff waiting is counted separately. Independent UI inspection, fixture events, exact saved contents/hashes and persisted state determine acceptance, not the agent's narrative.

| ID | Task | Agent s | Backend s | Main requests | CUA calls |
|---|---|---:|---:|---:|---:|
| J01 | Multi-step shipping draft; preserve fields; no submit | 24.192 | 28.259 | 8 | 0 |
| J02 | Paged lookup with duplicate names and disabled records | 16.544 | 20.773 | 6 | 0 |
| J03 | Asynchronous search; choose the active B device | 22.697 | 26.546 | 8 | 0 |
| J04 | Seven image-only readings | 24.960 | 31.032 | 5 | 1 |
| J05 | Selenium dynamic box and delayed input | 46.749 | 52.150 | 10 | 2 |
| J06 | Enable, fill and disable a control without losing its value | 23.060 | 27.608 | 8 | 0 |
| J07 | Calculator: 27.4 inches to centimeters | 32.912 | 39.554 | 8 | 0 |
| J08 | Notepad: replace two occurrences, save, verify complete text | 119.662 | 126.581 | 11 | 4 |
| J09 | Recursive PNG manifest; preserve originals; open on desktop | 85.748 | 92.933 | 13 | 2 |
| J10 | Native multi-control work order; generate one summary | 156.837 | 164.278 | 20 | 11 |
| J11 | Escape stops further desktop input | 58.950 | 67.830 | 10 | 2 |
| J11-resume | Resume in a new turn; write only the remaining field | 14.581 | 16.690 | 4 | 0 |
| J14 | MCP disconnect after write; reconcile before resuming | 45.040 | 55.782 | 9 | 1 |
| J15 | Foreground conflict; explicit assisted handoff and recovery | 86.043 | 97.379 | 11 | 0 |
| J16 | Target exits; no stray writes; honest incomplete report | 55.140 | 68.175 | 13 | 0 |
| J17 | Two identical screenshots; one CUA request | 30.558 | 36.175 | 6 | 1 |
| J18 | First execution of the public composite form | 33.778 | 40.352 | 10 | 0 |


[Before/after](../.local/windows-final-20261118/before-after.png) · [Correctness](../.local/windows-final-20261118/accuracy-comparison.png) · [Cache](../.local/windows-final-20261118/cache-comparison.png) · [All timings](../.local/windows-final-20261118/final-timings.png) · [CSV](../.local/windows-final-20261118/results.csv) · [HTML](../.local/windows-final-20261118/results.html) · [Acceptance gate](../.local/windows-final-20261118/final-gate.json)

## Performance and correctness

Each comparison bar represents one run; all rounds are in the CSV. Network conditions, initial control state, inference variability and different inputs are labeled. An old search run contained a 114-second main-model request; an old pagination run had two network timeouts. Both remain in the full data but are not used to inflate the headline comparison. Final Notepad took about 120 seconds with four CUA observations; the complex native form took 157 seconds with 11. The main model can still select an expensive full-image path. The form also had one stale-state rejection, safely reobserved before completion. Functional acceptance is not an across-the-board speedup or a claim of zero redundant calls.

The correctness chart reports checked-item agreement for seven frozen image readings, Calculator's displayed result and complete saved Notepad text, not general accuracy. An earlier image answer was correct but read hidden HTML and remains a route violation. The two activation-loop failures, missed injections, slow samples and network block are retained. The [November 17 interleaved legacy/candidate O/N comparison](computer-use-acceptance-2026-11-17.en.md) is historical evidence, not proof for this candidate. Filling two boxes and replacing/saving a document are different tasks.

## Automated validation and implementation

The following executed targets exited 0. Overlapping regressions are not summed as independent coverage. Real Electron browser tests are distinct from real-model product acceptance. No Rust Agent core was changed; unrelated full Rust suites and installer packaging were not run.

| Target | Result | Log |
|---|---|---|
| `browserControl.test.ts / Vitest` | 17 PASS; exit 0 | [view-regression-after.log](../.local/windows-final-20261118/view-regression-after.log) |
| `workspace-browser.electron.spec.ts / Playwright` | 1 PASS; exit 0 | [browser-electron-after.log](../.local/windows-final-20261118/browser-electron-after.log) |
| `TypeScript tsc --noEmit` | exit 0 | [typecheck-after.log](../.local/windows-final-20261118/typecheck-after.log) |
| `runtime/tests/browser-tool.test.mjs` | 5 PASS; exit 0 | [browser-runtime-after.log](../.local/windows-final-20261118/browser-runtime-after.log) |
| `runtime/tests/vision-routing*.test.mjs` | 20 PASS; exit 0 | [vision-final.log](../.local/windows-final-20261118/vision-final.log) |
| `runtime/harness/test/computer-skill.test.mjs + tool-discovery.test.mjs` | 16 PASS; exit 0 | [activation-handoff-host.log](../.local/windows-final-20261118/activation-handoff-host.log) |
| `runtime/harness/test/mcp-vision.test.mjs` | 9 PASS; exit 0 | [after-state-host-test.log](../.local/windows-final-20261118/after-state-host-test.log) |
| `tools/qwen-computer-use: go test ./...` | PASS; 32.354s; exit 0 | [go-activation-handoff.log](../.local/windows-final-20261118/go-activation-handoff.log) |
| `tools/qwen-computer-use: go vet ./...` | exit 0 | [go-activation-vet.log](../.local/windows-final-20261118/go-activation-vet.log) |

- [ui/desktop/src/workspace-panel/browserControl.ts](../ui/desktop/src/workspace-panel/browserControl.ts)
- [ui/desktop/src/workspace-panel/browserControl.test.ts](../ui/desktop/src/workspace-panel/browserControl.test.ts)
- [ui/desktop/tests/e2e/workspace-browser.electron.spec.ts](../ui/desktop/tests/e2e/workspace-browser.electron.spec.ts)
- [runtime/vision-routing.mjs](../runtime/vision-routing.mjs)
- [runtime/tests/vision-routing.test.mjs](../runtime/tests/vision-routing.test.mjs)
- [runtime/harness/tool-discovery.mjs](../runtime/harness/tool-discovery.mjs)
- [runtime/harness/profile.mjs](../runtime/harness/profile.mjs)
- [runtime/harness/skills/computer-use/SKILL.md](../runtime/harness/skills/computer-use/SKILL.md)
- [runtime/harness/test/computer-skill.test.mjs](../runtime/harness/test/computer-skill.test.mjs)
- [runtime/harness/test/mcp-vision.test.mjs](../runtime/harness/test/mcp-vision.test.mjs)
- [tools/qwen-computer-use/main.go](../tools/qwen-computer-use/main.go)
- [tools/qwen-computer-use/observation_test.go](../tools/qwen-computer-use/observation_test.go)
- [tools/qwen-computer-use/desktop-input.cs](../tools/qwen-computer-use/desktop-input.cs)
- [runtime/builtin-artifacts.mjs](../runtime/builtin-artifacts.mjs)
- [runtime/tools/provenance.json](../runtime/tools/provenance.json)

## Running and limitations

Run `.\start-preview.ps1` from `D:\CodeBuddy-v1`; the accepted preview is left running. Working main-model and CUA APIs are required. Specify the target window, fields and preservation boundaries. Control-readable facts are read directly. Avoid simultaneous keyboard/mouse input; Escape stops desktop input for that turn, and a later continuation reconciles existing values first.

OS foreground denial requires manual restoration of the exact window. A closed target must be reported incomplete without writing to similar windows. Actual API calls validate the service alias, not the remote weights: weight checksums, GPU details and cold-start data are unavailable. No quota exhaustion occurred, and provider billing quotas or rate limits cannot be independently reset.

The target-exit turn made redundant observations, host-rejected read-scope changes and two read-only process queries before stopping, taking 55.14 seconds. No stray writes occurred, but safety acceptance does not imply minimal recovery work. The full dataset retains 72 timed rounds, not 72 independently successful tasks.

Changes remain uncommitted and unpushed on the current main worktree; unrelated dirty work is preserved. Fixtures, sessions and per-run evidence remain under `.local/windows-final-20261118` and are not staged. Origins, hashes and receipts below identify the actual tested candidate.

## Build / Evidence

- Worktree: `D:\CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223`, dirty. Candidate: `final6-after-state-host`.
- Runtime PID: `10412`; Electron main PID: `46832`; launch: `2026-11-18 02:28:39 +08:00`.
- runtimeHash: `b13b5ffc02fc16e4e909352d0f61cd38f060ad74fb0ae8acdd45aa35fb02b909`
- controllerHash: `051E5FEE7A51277842E7ACF81D0AAA801C8B6CA2DF220330EFAE2410A750A924`
- nativeHash: `8AF5EBF26B61D598382323C2650108F87D84D8A13F2C11055D6BBEA096E637BD`
- visionHash: `B9F2CE79CA45694147A7E1CCF6B6BB62CE43FB23557CE6C45684B82A875E6368`
- discoveryHash: `9DB908163E561C953CB3C429B9EB2AFC9736DB1BD129DDFCD290287695E87A1B`
- profileHash: `91DBC6D6BECE27507BA6A65835DFAB1A579D0834FBF85765F3DE5BC08BBE86F6`
- skillHash: `66A1B0031793BB61DA04563FC52B7376C72943E55D2CBC55C99D00AE6BAED5B1`
- bundleHash: `C2934D38D8B7CB4BD46D52245C88FD6E2B1294C4A5563433DCFEF8B82C26325B`

[Loaded identity](../.local/windows-final-20261118/identity-verified.json) · [Launch receipt](../.local/windows-final-20261118/launch-unified.json) · [Native source manifest](../.local/windows-final-20261118/native-source-manifest.json)

| Case | Session | Evidence |
|---|---|---|
| J01 | `3cb655b4-ec09-4ad6-a860-948289e916ba` | [J01-independent.json](../.local/windows-final-20261118/J01-independent.json) |
| J02 | `1aded07b-58c4-4847-8121-c69fa0ae519a` | [J02-independent.json](../.local/windows-final-20261118/J02-independent.json) |
| J03 | `54a3ea0b-9dfc-4ec2-848a-ed5126f53f51` | [J03-independent.json](../.local/windows-final-20261118/J03-independent.json) |
| J04 | `a5ec7cdc-67cd-4854-8f3e-30f847244381` | [J04-independent.json](../.local/windows-final-20261118/J04-independent.json) |
| J05 | `857c1a8c-731b-49ba-92ba-b9e1699c440c` | [J05-independent.json](../.local/windows-final-20261118/J05-independent.json) |
| J06 | `7b78749c-e1ee-4c0a-9882-8e4b6f44cf77` | [J06-independent.json](../.local/windows-final-20261118/J06-independent.json) |
| J07 | `35e31902-e3b5-45f0-84ee-7dc58bd5d273` | [J07-independent.json](../.local/windows-final-20261118/J07-independent.json) |
| J08 | `93638c27-365d-4317-8948-6ed6961a600a` | [J08-independent.json](../.local/windows-final-20261118/J08-independent.json) |
| J09 | `eb987ad0-7441-4203-9d79-d8e114acbd37` | [J09-independent.json](../.local/windows-final-20261118/J09-independent.json) |
| J10 | `62a100ee-a342-4e63-bf99-ac9e4b8a23ee` | [J10-independent.json](../.local/windows-final-20261118/J10-independent.json) |
| J11 | `d81e5e61-0abf-4117-ae02-2d19a6fd6c1e` | [J11-independent.json](../.local/windows-final-20261118/J11-independent.json) |
| J11-resume | `d81e5e61-0abf-4117-ae02-2d19a6fd6c1e` | [J11-resume-independent.json](../.local/windows-final-20261118/J11-resume-independent.json) |
| J14 | `ac3f61e5-5951-4728-84ae-2723cbc289fd` | [J14-independent.json](../.local/windows-final-20261118/J14-independent.json) |
| J15 | `fa3a730d-f88b-4f75-b43f-97785559211a` | [J15-independent.json](../.local/windows-final-20261118/J15-independent.json) |
| J16 | `905f5011-c963-4e7f-abcb-cb24ff0d0320` | [J16-independent.json](../.local/windows-final-20261118/J16-independent.json) |
| J17 | `467be12a-a670-4bda-a448-f32cc515dba6` | [J17-independent.json](../.local/windows-final-20261118/J17-independent.json) |
| J18 | `93b52177-413b-4e60-a1a2-ab0a74a4d812` | [J18-independent.json](../.local/windows-final-20261118/J18-independent.json) |
