# Windows Computer Use final implementation and acceptance

2026-11-17. [简体中文](computer-use-acceptance-2026-11-17.zh-CN.md) / [繁體中文](computer-use-acceptance-2026-11-17.zh-TW.md).

The agreed Windows matrix passed all **22 real product turns**. Fault cases pass by stopping safely or recovering correctly; an interrupted form is not reported as a completed form. Later user instructions supersede the optional routes in the original integration guide: the normal main model decides, CUA observes only. Mac, CUA action selection, and installer packaging are excluded.

## Build and implementation

Workspace `D:/CodeBuddy-v1`, delivery HEAD `main@4c8afad97` plus preserved uncommitted changes. The earlier recorded `a071a6ba4` is the historical controller baseline; a 19:09 settings UI commit predates the final launch and does not include this batch's runtime/native/browser-controller changes. This acceptance work created no branch, commit, push, dependency installation, or installer. Started with `./start-preview.ps1` at 20:00:59 China time. Runtime PID 36356; Electron main PID 30680 started at 20:01:31.057, after bundle write at 20:01:31.010. All final product turns occurred after this restart. The disclosure candidate appearing in a real task also confirmed the loaded implementation. The loaded hashes below establish the tested identity.

- Runtime SHA256: `24b4546fcec0272119a858e98d3e5347b45d1ad978ef801ee54c1a20022ad81b`.
- Browser source SHA256: `a5d2454ec1d343bc947604659ec66e6e5ae96ef63d5b66576e5065b555061c79`.
- Electron bundle SHA256: `5fe2a65e00521cf0ebb7a2a83148c32750313c9702ffe3a2b62861a20454bb4c`.
- Native tool SHA256: `496acac575f93c69c804e3e4cbd7b220ccf799aa1b485fd25f527b3239bbd107`.
- Main model: `deepseek-v4.1-flash:1017`, existing maximum reasoning setting preserved. CUA: `CUA-S1-Qwen3.5-4B`; recorded observer sessions expose no action tools. Remote weight revision, hardware, peak memory and cold start are unverified.

Windows control-first observation now covers button applications, including Calculator. Whole-field updates support guarded legacy WinForms EDIT controls. Window identity, focus, original values, occlusion and takeover checks remain enforced. Identical images are reused only within the matching turn/window/process/model/content scope; cancellation invalidates late results.

Browser candidates bind an observation, page in groups of 24, and reference literal text values. This batch added disclosure-triangle candidates and a second semantic check immediately before dispatch, including after focus. A candidate is consumed before dispatch so an uncertain action cannot be blindly replayed. Existing optimizations also batch JSON writes, update usage locally, insert sessions locally, and avoid copying full tool schemas during registry notifications while retaining permission checks.

Direct batch changes: `runtime/browser-tool.mjs`, `ui/desktop/src/workspace-panel/browserControl.ts`, its unit and Electron tests, and `examples/computer-use/candidate-boundaries.html`. Earlier related implementation includes runtime settings/store/compat/vision, Harness discovery/skill/vision bridge, and native tool Go/PowerShell/C# files. Evidence stays local by default.

## Automated validation

All listed commands exited 0 using existing tools: `node --test runtime/tests/browser-tool.test.mjs` (4 tests, 28.367 s); `vitest run src/workspace-panel/browserControl.test.ts` (9 tests, 2.11 s); `playwright test tests/e2e/workspace-browser.electron.spec.ts` (1 real Electron integration, 13.4 s); `tsc --noEmit`. The later one-line disclosure role was also compiled by the passing Electron integration. Native `go test ./...` passed in 32.888 s; `go vet ./...` and the native build passed. Unchanged related suites already passed: settings/store 27, history 15, vision 16, MCP vision 9, skill 3, tool scope 6, agent profile 4. These are separate from main-model product acceptance. Logs: `.local/computer-use-next/` and `ui/desktop/.local/`.

## Native results

Identical task prompts, fresh chats and blank fixtures; Notepad body and disk remain unchanged, no replacement/save; Calculator starts at zero with empty history and computes 37×24=888. Times below measure turn execution.

| Task | Before s | Final s / mean | Reduction | Final checks |
| --- | --- | --- | --- | --- |
| CRM | 92.133 | 31.696 | 65.6% | 15/15 (3 runs) |
| Notepad | 65.706 | 31.606 | 51.9% | 4/4 |
| Calculator | 162.433 | 46.964 | 71.1% | 2/2 |

| CRM run | Execution s | Received-to-settled s | Main requests | Main s | CUA calls | CUA s |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 28.409 | 35.988 | 8 | 18.968 | 0 | 0.000 |
| 2 | 40.444 | 48.202 | 8 | 21.921 | 1 | 5.810 |
| 3 | 26.234 | 34.410 | 7 | 17.852 | 0 | 0.000 |

CRM execution mean 31.696 s; total wait mean 39.533 s. Mean breakdown: main model 19.580 s, CUA 1.937 s, remaining tools 9.402 s, other 0.777 s. Run 2 includes the model's unnecessary full-view request after correct writes. The slower sample was retained. Before measurements are single samples, final CRM has three; this is not an SLA or general vision-accuracy estimate.

## Browser comparison

O uses legacy node/text calls; N uses observation/candidate/literal-value calls **in the same final build**. Order: O1,N1,N2,O2,O3,N3. Each opens a fresh blank form containing 450 history records. Arguments, final controls and independent visible state were checked.

| Mode | Execution s | Received-to-settled s | Main requests | Main s | Tool calls | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | 35.231 | 47.270 | 9 | 27.630 | 8 | 5/5 |
| N2 | 37.881 | 46.723 | 9 | 33.171 | 7 | 5/5 |
| N3 | 30.080 | 39.688 | 9 | 25.798 | 7 | 5/5 |
| O1 | 35.645 | 43.977 | 7 | 30.369 | 6 | 5/5 |
| O2 | 26.681 | 35.896 | 10 | 21.551 | 8 | 5/5 |
| O3 | 29.168 | 40.205 | 8 | 22.888 | 7 | 5/5 |

Execution means: O 30.498 s, N 34.397 s. Total wait means: O 40.026 s, N 44.560 s. Legacy calls in the new build are not the same experiment as running the old product.

Delayed search typed 海风 and selected only 海风测试, with exact visible output:

| Mode | Execution s | Checks |
| --- | --- | --- |
| O | 23.147 | 3/3 |
| N | 46.804 | 3/3 |

Search N made one additional screenshot request: CUA took 20.460 s; the main model took 17.312 s. The observation contained the status name and matching text but flattened away their parent-child relationship. This may have prompted visual confirmation (an inference from the receipt). Preserving the relevant control relationship is a concrete next optimization experiment, not an improvement claimed as implemented here.

A separate real Electron mechanism experiment loaded the historical controller from `a071a6ba4` and the current source. All 12 normal trials passed (short/dense form, three runs each per mode). Both before-dispatch and on-focus field-renaming races caused wrong writes in the old controller; both were rejected without writing in the new candidate path. This experiment has no main model and does not measure user end-to-end latency. Legacy node compatibility still lacks candidate semantic binding; do not generalize the new guard to every legacy call.

## Faults and public sites

- Focus changed to Calculator 53 ms after the first observation ended, before the next action. All four input attempts were rejected; neither app changed. Safe-stop PASS, form incomplete. Repeated attempts count in latency.
- Esc during the pending email write returned DESKTOP_STOPPED, left email blank, and produced no further desktop calls. The next turn listed/observed afresh and wrote only the remaining email; company was not repeated. Recovery: 14.407 s, all field and sequence checks passed.
- Closing the isolated CRM during Raise after-state collection led to exact-window-not-found and no subsequent write to another window.
- Killing only the session's MCP process after company input but before its receipt produced Connection closed. Recovery reread the form and wrote only email, with no duplicate company input.
- Closing Notepad's replacement pane prevented input and reopening; body/file unchanged. Three full observations made this safety test take 95.752 s.
- Paging found the initially absent disclosure candidate; disabled, readonly and covered fields stayed unchanged. Eight checks plus five independent values passed.
- [Selenium official form](https://www.selenium.dev/selenium/web/web-form.html): text, textarea, select Two, default checkbox, preserving existing checked/readonly/disabled controls; no submit/password/upload. 41.776 s, 9 checks, zero CUA.
- [Playwright TodoMVC demo](https://demo.playwright.dev/todomvc/): add two test items to an empty list, complete only A, verify Active/Completed/All, no deletion. 63.293 s, 7 checks, zero CUA.

All fault checks use actual model tool receipts, injection times and independent state, not agent claims. Public pages were operated through the product browser; no DOM mutation manufactured passing results.

## Limits and next optimization

Remaining latency is dominated by main-model round trips, optional full observations and repeated attempts after takeover. Reduce unnecessary observation/response work without removing semantic/focus guards or taking decisions away from the main model. Candidate safety improved demonstrably; speed conclusions must follow the measured table.

An earlier CUA observation misidentified Notepad as File Explorer and was cached; it is retained as a failure. Three later correct fixed-image samples do not establish general reliability. Cache hits are not independent accuracy samples. Remote weight/hardware/resource qualification remains unverified; the user replaced the original CUA action-decider experiment with observer-only routing.

The 19:27 Electron process had not loaded the 19:28 bundle. Its intermediate results were excluded from the final matrix, preserved under `intermediate-1927/`, and rerun after the 20:01 restart. Calibration and validator mistakes are recorded separately from product defects. No slow valid trial was discarded.

## Evidence

[Acceptance gate](../.local/computer-use-next/final-acceptance-gate.json), [chart](../.local/computer-use-next/Windows最终统一复测对比.png), [per-turn CSV](../.local/computer-use-next/Windows最终逐轮数据.csv), [timing breakdown](../.local/computer-use-next/final-product-timings.json), [launch identity](../.local/computer-use-next/launch-unified.json), [loaded main](../.local/computer-use-next/loaded-main-identity.json), [browser comparison](../.local/computer-use-next/browser-main-comparison.json), [historical controller experiment](../.local/computer-use-next/browser-baseline/results.json). Fault receipts: `final-{focus,escape,resume,close,disconnect,pane}-verification.json`; public checks: `public-S1-verification.json`, `public-T1-verification.json`. Raw turns: `unified-<session>-<turn>.json`.

| Session / turn | Execution s | Main requests | CUA calls | Tool calls |
| --- | --- | --- | --- | --- |
| 784242d9-7749-4468-9b0f-1c2d29600adb / 1 | 84.702 | 13 | 1 | 13 |
| ebc58103-f500-4e61-b778-d9aab2f568dc / 1 | 37.649 | 9 | 1 | 7 |
| ebc58103-f500-4e61-b778-d9aab2f568dc / 2 | 14.407 | 4 | 0 | 3 |
| 131b145d-5af3-4560-b391-32e15e32c675 / 1 | 42.009 | 8 | 2 | 6 |
| 29a7b3d9-8edb-45a4-aad2-6809a36fddfd / 1 | 66.016 | 12 | 2 | 10 |
| c1dc7027-66f2-49e5-8133-930f2dd703f8 / 1 | 95.752 | 8 | 3 | 6 |
| 1f28fe04-f0f0-4538-a602-ac817604663d / 1 | 35.748 | 0 | 0 | 9 |
| 8eb4fb5f-7ebe-425b-a810-ad1a15bfe9f5 / 1 | 41.776 | 8 | 0 | 11 |
| 9d237d3b-3b4f-42ad-8290-2c2c596d7e5b / 1 | 63.293 | 20 | 0 | 18 |
| 35f30ef0-dbd6-4a7d-84de-beb1755ec46d / 1 | 28.409 | 8 | 0 | 6 |
| 5c397166-432b-4d02-8072-bba552524fbe / 1 | 40.444 | 8 | 1 | 7 |
| 5f10003a-bfe2-43ac-8a94-3a4a1cf09a00 / 1 | 26.234 | 7 | 0 | 6 |
| b2c3b7a7-0def-4997-874d-86bb921426e0 / 1 | 31.606 | 8 | 0 | 6 |
| bd5cdd1f-7790-4c13-bbe9-a653e7f67793 / 1 | 46.964 | 12 | 0 | 10 |
| 19af5992-cbfd-4f3b-8af5-a553ca04ba4a / 1 | 35.231 | 9 | 0 | 8 |
| e9b7de3a-33e4-40d8-9e8b-f684035be41a / 1 | 37.881 | 9 | 0 | 7 |
| 7e0e0f2b-98ac-422e-98a8-0262657b0fcd / 1 | 30.080 | 9 | 0 | 7 |
| e9ab3135-1b00-4908-a355-78a1b795af62 / 1 | 35.645 | 7 | 0 | 6 |
| debc2ac0-8ed1-495e-b017-5ba21818bd42 / 1 | 26.681 | 10 | 0 | 8 |
| cfae921b-6b33-4876-92af-afa19c081713 / 1 | 29.168 | 8 | 0 | 7 |
| 3c4a8190-dad5-478c-85e3-4d86b82d0377 / 1 | 23.147 | 9 | 0 | 7 |
| b852a055-c392-405d-8f49-ee8e5f9421d8 / 1 | 46.804 | 9 | 1 | 8 |

The agreed Windows development-build acceptance is complete. Launch from the repository with `./start-preview.ps1`. No installer, Mac acceptance, or universal application-success claim is included.
