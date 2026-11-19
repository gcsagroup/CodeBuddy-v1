# Reducing repeated main-model observations: browser acceptance

2026-11-17

[简体中文](computer-use-browser-roundtrips-2026-11-17.zh-CN.md) · [繁體中文](computer-use-browser-roundtrips-2026-11-17.zh-TW.md) · [English](computer-use-browser-roundtrips-2026-11-17.en.md)

The main model remains deepseek-v4.1-flash:1017 with max reasoning. CUA-S1-Qwen3.5-4B remains a visual observer only. This change affects browser observations and tool guidance, not model selection, reasoning effort or vision routing.

| Task | Before / s | After / s | Reduction | Passed |
| --- | ---: | ---: | ---: | --- |
| form | 27.660 | 19.007 | 31.3% | 3/3 → 3/3 |
| search | 31.376 | 18.627 | 40.6% | 3/3 → 3/3 |

![Comparison](../.local/browser-roundtrips-20261117/浏览器优化前后对比.png)

Across six runs, separate observe calls fell from 16 to 0 and console calls from 1 to 0. All final runs used four tools and five task-model requests, with zero tool errors and zero CUA invocations. Average task-model time was 14.67 s for forms and 14.05 s for search; model work remains the dominant measured cost.

Open returns compact controls, candidates and registered literals immediately, removing separate observation and literal-registration round trips. Explicit observe still defaults to full page text; view=controls requests compact output. Literals persist across same-page observations; [] clears them and navigation resets them.

After an action, real controls are sampled about every 80 ms until approximately 240 ms of quiet or an 800 ms polling budget. Async search suggestions can then be used directly. Read and scheduling time are not a hard wall-clock timeout guarantee. Quiet does not prove business completion; missing results still require observation.

The main model judges completion from fresh action receipts. verified:false means the host does not decide completion, not that another observation is mandatory. Missing information warrants another observation; routine final screenshots, observe and console calls are unnecessary. Stale-candidate, coverage, focus-change and uncertain-dispatch protections remain.

Two development form runs took 21.172 / 22.206 seconds and finished correctly, each recovering from one missing tab ID. The receipt now places the tab ID first and guidance explicitly requires id, observationId and candidateId together. Development evidence is retained separately from the six final-build runs.

The baseline is the previous final build’s six real-product runs, not the older, slower initial implementation. After restarting this build, three fresh chats per task use identical form and search prompts; only the form N1/N2/N3 labels differ. Fixtures and their 160 ms async-search delay are unchanged.

Correctness checks both target fields, preserved billing email and note, and zero submissions; search checks the query, intended candidate, avoidance of the billing candidate and actual selected status. All six final runs have independent Windows visible-control readbacks. Agent assertions alone are not acceptance evidence.

Timing is Harness turn/start to turn/end, including model work, tools and recovery, excluding chat creation, pre-send waits and independent verification. UI timing can be longer. Sequential, non-randomized runs remain affected by network, remote load, caching and model variation. Three-run averages are not universal guarantees; task accuracy is not general vision accuracy.

Checks passed with exit code 0: browser-controller Vitest 16/16, runtime browser-tool 5/5, TypeScript --noEmit, real Electron integration 1/1. The final property-order and tool-text adjustment was followed by another runtime 5/5 pass and six product runs after restart. Installer, Mac and unaffected native-app suites were not rerun.

Delivery source: D:\CodeBuddy-v1, main, revision below, including this change and existing dirty work. No branch creation, commit, push or installer. Built and launched with the repository .\start-preview.ps1 entry point.

| Phase / task | Session | Seconds | Tools | Main requests | CUA | Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| after / form | `c7387663-9bbe-441b-a421-5a06d98e2702` | 17.500 | 4 | 5 | 0 | 0 |
| after / form | `f651375d-46f1-4cea-b2ec-dac59d0a562a` | 19.765 | 4 | 5 | 0 | 0 |
| after / form | `819dd277-d858-44a4-9a40-1486587f1188` | 19.755 | 4 | 5 | 0 | 0 |
| before / form | `463855e6-ac1d-43df-9760-c0db9f17aca3` | 27.193 | 6 | 7 | 0 | 0 |
| before / form | `2d350f7d-c80f-42ce-bb7b-bb1f9d4572df` | 34.292 | 7 | 8 | 0 | 0 |
| before / form | `d1dc9982-5118-4a63-bbb3-71a2d55c6a16` | 21.496 | 5 | 6 | 0 | 0 |
| after / search | `c748fe22-c875-4d06-9746-0784e44f680f` | 15.805 | 4 | 5 | 0 | 0 |
| after / search | `22bc5d3f-25c7-47fd-adac-b3001b47ac6c` | 20.728 | 4 | 5 | 0 | 0 |
| after / search | `98fbce58-bd9e-430a-9541-98cb928d329f` | 19.347 | 4 | 5 | 0 | 0 |
| before / search | `a094730b-de7d-4d87-a25b-a6377c6c4ca2` | 32.291 | 9 | 10 | 0 | 0 |
| before / search | `0c60ccc5-d576-4ff9-a0c1-ca8f768bcec1` | 29.510 | 8 | 8 | 0 | 0 |
| before / search | `813540ca-7b4d-426f-a35b-9ef60207f7b3` | 32.328 | 7 | 8 | 0 | 0 |

Main request counts exclude explicitly tagged session-title calls; task reasoning is max throughout. Automatic titles retain the existing off setting and may run concurrently. Per-session title timing is retained separately. This corrects the earlier report’s mixed request count without changing end-to-end elapsed time.

```json
{
  "revision": "4c8afad978b6e893a3545c0859dd5b4824a91223",
  "electron": {
    "sourceHash": "063A7948F121E9476A201DCC2D8269B87E4FF0503D0347E675630B4A8F75C053",
    "started": "2026-11-17T22:45:02.0319770+08:00",
    "bundleWritten": "2026-11-17T22:45:01.9978947+08:00",
    "revision": "4c8afad978b6e893a3545c0859dd5b4824a91223",
    "electronPid": 44888,
    "bundleHash": "A0A2B56597446D12A5E002584E590F6C6B9ECBD7C4367D5A9154DAA3571219E0"
  },
  "runtime": {
    "pid": 48300,
    "startedAt": "2026-11-17T14:44:47.645Z",
    "sourceHash": "c99fce2a15e62318651d11d680dc04afae4bcc97f44457ea3f17fe18c51c4d49",
    "currentHash": "c99fce2a15e62318651d11d680dc04afae4bcc97f44457ea3f17fe18c51c4d49",
    "restartRequired": false
  }
}
```

Changed files:

- `runtime/browser-tool.mjs` + `runtime/tests/browser-tool.test.mjs`
- `ui/desktop/src/workspace-panel/browserControl.ts` + `.test.ts`
- `ui/desktop/src/workspace-panel/workspacePanelMain.ts`
- `ui/desktop/tests/e2e/workspace-browser.electron.spec.ts`

Commands (existing Node 24 runtime, cwd `ui/desktop` except runtime tests):

```powershell
node ../node_modules/vitest/vitest.mjs run src/workspace-panel/browserControl.test.ts
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/@playwright/test/cli.js test tests/e2e/workspace-browser.electron.spec.ts --reporter=list
node --test runtime/tests/browser-tool.test.mjs
```

[Raw data](../.local/browser-roundtrips-20261117/comparison-data.json) · [Source identity](../.local/browser-roundtrips-20261117/loaded-identity.json) · [Independent readback validation](../.local/browser-roundtrips-20261117/visible-check.py)

Local evidence: `.local/browser-roundtrips-20261117/` contains session exports, model timings, visible readbacks, runtime logs and reproducible chart/report scripts. Previous baseline evidence remains in `.local/browser-observation-20261117/`.

Design reference: [Playwright actionability](https://playwright.dev/docs/actionability) and [retrying assertions](https://playwright.dev/docs/test-assertions) motivate read-before-next-step checks. This bounded accessibility settling mechanism is project-specific and does not replace an explicit outcome assertion. No external code or dependency was imported.
