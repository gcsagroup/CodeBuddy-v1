# Browser observation optimization and acceptance

2026-11-17

[简体中文](computer-use-browser-optimization-2026-11-17.zh-CN.md) · [繁體中文](computer-use-browser-optimization-2026-11-17.zh-TW.md) · [English](computer-use-browser-optimization-2026-11-17.en.md)

## Result

Same form and dynamic-search tasks, three runs before and three after each. Main model remains deepseek-v4.1-flash:1017 with maximum reasoning; CUA-S1-Qwen3.5-4B remains a tool-free visual observer. All six final task runs pass their checks without CUA calls.

| Task | Before mean | After mean | Reduction | Task accuracy |
| --- | ---: | ---: | ---: | --- |
| Form | 34.40 s | 27.66 s | 19.6% | 3/3 → 3/3 |
| Search | 40.85 s | 31.38 s | 23.2% | 3/3 → 3/3 |

![Comparison](../.local/browser-observation-20261117/浏览器优化前后对比.png)

## Changes

1. Browser actions return a fresh compact accessibility observation and new candidates. Validated literal references carry into this after-state; the planner can perform the next step without a separate observe call. Full page observation remains available.
2. Accessibility parent relationships and status/alert descendant text remain explicit. The selected-customer status can be distinguished from a suggestion with the same text. Readable control values do not require OCR.
3. Identical browser screenshots reuse the last completed observer result only within the same turn, session, tab, navigation revision, model and exact image hash. Changed images, navigation, targets and canceled work do not reuse an invalid result. Current tool text receipts are preserved.
4. The bundled CUA direct-reading configuration now covers browser captures, with no tools and thinking disabled for that observer only. Main-model reasoning settings and ordinary uploaded-image questions are unchanged.
5. Invalid type parameters are rejected before candidate consumption or input. Uncertain actual dispatch still consumes the candidate; failed after-state observation reports dispatch truth and never replays input. Legacy node callers retain still-present nodes from their prior full observation.

The structure follows the existing CDP owner and the hierarchical accessibility approach described in [Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots). No external implementation or dependency was copied.

## Build and verification

- `D:/CodeBuddy-v1`, `main@4c8afad97` + dirty work; `./start-preview.ps1`.
- Runtime PID 28160, Electron PID 17324; started `2026-11-17T21:37:06.9688940+08:00`, bundle written `2026-11-17T21:37:06.9360807+08:00`.
- Runtime SHA256: `949630197931caf5a7a464c5125d5807b7f6c915ba6555ed5460265a30773d3e`.
- Controller SHA256: `12C5E376E02316C6273D24DC7A0FDE9D548049AACB355CA59FEA6238708F97DC`.
- Bundle SHA256: `273C03A705C277FFFD1AB5851CEE4909546CF7582F7AE1618645B83A91EFCF38`.
- No branch, commit, push, dependency install or installer was created. Unrelated dirty work was preserved.

| Command | Result / exit |
| --- | --- |
| `vitest run src/workspace-panel/browserControl.test.ts` | 13 PASS / 0 |
| `tsc --noEmit` | PASS / 0 |
| `node --test runtime/tests/vision-routing.test.mjs` (final cache-key regression) | 14 PASS / 0 |
| `playwright test tests/e2e/workspace-browser.electron.spec.ts --reporter=list` | 1 PASS, 13.7 s / 0 |
| `node --test runtime/tests/vision-routing.test.mjs runtime/tests/browser-tool.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/harness/test/mcp-vision.test.mjs` | 31 PASS / 0 |
| `node --test --test-name-pattern='host.*(capture identity\|image admission\|screenshot)' runtime/harness/test/capabilities.test.mjs` | 3 PASS / 0 |
| `node --test runtime/tests/browser-tool.test.mjs` (final description) | 4 PASS / 0 |

Commands used the existing Node 24 and ui/node_modules executables. The initial wrong desktop/node_modules Vitest path was corrected to the installed workspace dependency; nothing was installed. The first restart attempt waited for the old runtime to exit before retrying.

## Raw task runs

| Phase / task | Session | Seconds | Tools | Main requests | CUA |
| --- | --- | ---: | ---: | ---: | ---: |
| after / form | `463855e6-ac1d-43df-9760-c0db9f17aca3` | 27.193 | 6 | 8 | 0 |
| after / form | `2d350f7d-c80f-42ce-bb7b-bb1f9d4572df` | 34.292 | 7 | 9 | 0 |
| after / form | `d1dc9982-5118-4a63-bbb3-71a2d55c6a16` | 21.496 | 5 | 7 | 0 |
| before / form | `19af5992-cbfd-4f3b-8af5-a553ca04ba4a` | 35.231 | 8 | 9 | 0 |
| before / form | `e9b7de3a-33e4-40d8-9e8b-f684035be41a` | 37.881 | 7 | 9 | 0 |
| before / form | `7e0e0f2b-98ac-422e-98a8-0262657b0fcd` | 30.080 | 7 | 9 | 0 |
| after / search | `a094730b-de7d-4d87-a25b-a6377c6c4ca2` | 32.291 | 9 | 11 | 0 |
| after / search | `0c60ccc5-d576-4ff9-a0c1-ca8f768bcec1` | 29.510 | 8 | 8 | 0 |
| after / search | `813540ca-7b4d-426f-a35b-9ef60207f7b3` | 32.328 | 7 | 9 | 0 |
| before / search | `b852a055-c392-405d-8f49-ee8e5f9421d8` | 46.804 | 8 | 9 | 1 |
| before / search | `a75f0367-968a-44e5-a535-692c4ed896b5` | 43.319 | 9 | 10 | 0 |
| before / search | `070d3d63-260c-4634-bee9-ab13cdec1eec` | 32.437 | 7 | 8 | 0 |

## Cache verification and limits

The screenshot tool calls took **6.967 s and 0.833 s**. There was one CUA inference (5.881 s, zero action tools). capturePage runs each time; only completed observation text is cached. The main model’s speculation that a cached screenshot replaced the second capture is not an authoritative implementation fact.

Search tool calls remain at a mean of 8, while main-model requests are 9 → 9.33. The measured search gain primarily comes from avoiding CUA, not fewer tool round trips. Form tool calls are 7.33 → 6. Mean main-model request time is still 23.86 s for forms and 25.64 s for search. The baseline is the candidate-interface version before this optimization; its source identity is in before-hashes.json.

- Cache session: `1c5db5d0-42af-4b0c-bb6b-94f47e2f6404`. Screenshot calls: 2; CUA sessions: 1; reused observations: 1.
- A development run took 44.664 s and recovered from two parameter/stale-candidate errors before filling correctly. Its evidence is retained separately; it predates the final fix and is excluded from the final-version comparison.
- Timing is Harness turn/start to turn/end, including model and tool work, excluding session initialization and independent manual verification. Runs were sequential, not randomized; remote load, caching and model variation remain confounders.
- Form correctness covers both target fields, unchanged billing email and note, and zero submissions. Search covers the query, selecting the intended candidate, avoiding the billing candidate and the actual selected result. All final runs also have independent visible control readbacks. Baseline search run 3 has action/control receipts but no retained independent visible page readback; its pane had closed. Small-sample task success is not general vision accuracy.
- The main model still sometimes re-observes or checks console unnecessarily. That remaining latency is included, not hidden. Cached vision preserves an observation and cannot correct an incorrect recognition. Mac, installer and unchanged native-app acceptance were not rerun in this browser slice.

## Files and evidence

- `ui/desktop/src/workspace-panel/browserControl.ts` + `.test.ts`
- `ui/desktop/tests/e2e/workspace-browser.electron.spec.ts`
- `runtime/browser-tool.mjs`, `runtime/vision-routing.mjs`, `runtime/compat.mjs`, `runtime/harness/driver.mjs`
- `runtime/tests/vision-routing.test.mjs`, `runtime/harness/test/capabilities.test.mjs`
- [Data](../.local/browser-observation-20261117/comparison-data.json), [cache evidence](../.local/browser-observation-20261117/cache-validation.json), [source identity](../.local/browser-observation-20261117/loaded-identity.json).
- `.local/browser-observation-20261117/`: raw session exports, timings, visible control readbacks, runtime logs, chart and reproducible analysis scripts. Local evidence remains uncommitted.

[Final process/bundle check](../.local/browser-observation-20261117/final-identity-check.json) · [Runtime hash check](../.local/browser-observation-20261117/runtime-source-check.json) · [Verification summary](../.local/browser-observation-20261117/verification-summary.json)
