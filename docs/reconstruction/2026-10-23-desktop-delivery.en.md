# Desktop streaming and delivery fixes — 2026-10-23

[简体中文](2026-10-23-desktop-delivery.zh-CN.md) · [繁體中文](2026-10-23-desktop-delivery.zh-TW.md)

> This document retains chronological development notes. “Rebuild pending” and “Mac LAN pending” describe earlier states. Rebuilding and scoped installed-product acceptance subsequently completed; see the [merge handoff](2026-10-23-merge-handoff.en.md) for current results, limits and Git commits. Local Ollama and Ollama Cloud have different acceptance scope.

Source: `D:\CodeBuddy-v1`, branch `main`, revision `d43fcbbd0ec85afcb073cb74b14e835752a26e20`, plus existing and current uncommitted changes. There were 278 dirty entries at handoff. No branch, commit or push was created. The Mac checkout at `/Users/erjinyi/Desktop/work/CodeBuddy-v1` is identified by a verified SHA256 file snapshot, rather than its older Git HEAD.

## Findings and implementation

The original game session produced its first reasoning at 3.34s and first text at 14.29s, then stopped at 118.13s without writing a file. Its next turn spent about 100s generating write arguments and never called the browser. These facts do not establish that the UI buffered the entire answer.

Streaming code and completed code over 8000 characters now render as complete plain code blocks, avoiding repeated syntax highlighting. Short completed code remains highlighted. ResizeObserver layout writes are coalesced into an animation frame with cleanup. Window errors are distinguished from React rendering crashes. Transport diagnostics record the first tool argument and argument length, without logging contents; progress identifies argument generation as not yet executed.

The initial tool set includes write, edit and browser_control only when the scoped registry permits them; other tools remain discoverable on demand. The model interprets project delivery versus example-only requests. No host keyword classifier was added. Browser opening requires a real tab ID and HTTP(S) URL. Instructions require file delivery, browser inspection and reports grounded in tool receipts and actual links.

Ollama retains the existing Local Ollama setup and uses `/api/tags` and `/api/show` to identify chat/tools/vision capabilities. Explicitly incompatible models report the reason; unknown metadata remains compatible. LAN defaults remain `http://192.168.9.101:8001`, `gemma-4-26B-A4B-it-uncensored-FP8-W8A16`, 65536 context and image support. Existing settings and deliberate removal of the default connection are preserved.

References: [React memo](https://react.dev/reference/react/memo), [useDeferredValue](https://react.dev/reference/react/useDeferredValue), [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md). No dependency or artificial playback delay was introduced.

## Verification

Windows Node suites: initial 26 passed; follow-up 16 passed; distribution defaults 6 passed; latest work-status 8 passed. UI suites: 60 passed, plus 115 cancellation/history tests. Browser streaming: 4 passed. Scroll and native embedded-browser tests: 21 passed. Mac Node suites: 38 passed and 1 platform-conditional skip, plus 8 status tests. Mac UI: 109 passed. Mac streaming/native browser: 5 passed. TypeScript checks passed on both systems. These commands exited 0; the Chinese report and local logs list exact targets.

For the same Windows long-code fixture with 112 renders: p95 decreased from 9.7ms to 3.9ms, maximum from 748.7ms to 9.1ms, total render time from 2099.9ms to 304.7ms, and long tasks from 3/1583ms to zero. Mac after-fix p95 was 4.2ms, maximum 6.9ms, with zero long tasks. This is a controlled fixture, not a universal performance or sustained-memory guarantee.

Real Windows session `d21a0cca-c56f-4954-b593-54400b250380` wrote plane_war.html (9720 bytes, 345 lines), then opened the actual game in the right embedded browser. Restart interaction was observed. The 32s opening turn included approximately 27s of approval waiting; the browser receipt followed approval in about 0.3s. Stop returned the UI to idle in 212ms and recorded a Harness user abort in 253ms. Original history remained readable. A later development-page reload released browser tabs; its cause was not established and cross-restart tab restoration is not claimed. The initial final message still incorrectly asked the user to save code; the final instruction now requires actual file links and needs a fresh-session acceptance check.

Windows Ollama is reachable with no installed models. No running service or standard installation was found on Mac. No model was downloaded; actual Ollama inference, tool use and vision remain unverified. Full Mac model workflows, sustained memory pressure, installation/uninstallation and public distribution are not established by unit tests or packaging.

Evidence: Windows `.preview-evidence/desktop-fixes-20261023`; Mac `/Users/erjinyi/Desktop/work/desktop-fixes-20261023`. Local `delivery.json` records package paths, signing, hashes and final startup status. Existing data remains in `browser-control-20261022/profile-ready`; adjacent `manual-tests` contains prompts.

## Manual acceptance

1. In a fresh chat request an HTML airplane game. Verify a real file, change card and right-side page. The user handles any approval prompt. The final answer must link the actual file.
2. Ask to open it on the right, then inspect and interact with it. A textual success claim alone does not pass.
3. Ask for an HTML button example without creating files. Expect only an example.
4. During long output test scrolling, typing, stopping, switching chats and returning to history. Verify complete copied text and no late growth after cancellation.
5. Launch with a fresh isolated data directory: the new-task entry and default LAN model should be ready without mandatory setup. Existing profiles must preserve settings and history.
6. Add Local Ollama and load existing models. Empty inventory must not trigger a download. Test a small file with a tools-capable model and an image with a vision-capable model. Offline services and models without tool support should show clear errors.


## Two bundled connections

Fresh installations include CodeBuddy LAN and the existing ollama cloud connection (https://ollama.com, 22 model presets). LAN remains initially selected. This build includes the shared Ollama Cloud key explicitly authorized by the user. First launch imports it into platform-protected storage; users can select cloud models immediately. Unconfigured connections remain visible as setup cards, while executable model and subagent selectors include only configured providers. Existing user settings are preserved. Changes cover runtime/default-model.json, store.mjs, distribution-model.test.mjs, ModelsAndRuntimeSettings, ProviderSettingsPage and three settings regression suites.

The final Windows runtime selection passed 51 tests. Distribution and atomic storage passed 13 tests on both platforms. Settings UI passed 10 tests across three files; Windows typecheck and focused ESLint exited 0. The final source manifest is shared-cloud-source/source.json; local delivery.json records final artifact identities and verification.

The Mac DMG layout now uses an explicitly created Finder window, resolving layout failures with older same-name volumes mounted. Existing volumes were preserved and a complete DMG build passed. Windows staging uses the user-approved temporary directory without changing original directory permissions.

## Continued acceptance findings and fix (2026-10-23)

A real cloud task exposed a host browser screenshot adapter gap: raw images bypassed official attachment admission, and the next model request failed on a missing attachmentId. Host tools now reuse vision routing and Harness attachment storage, persist image references, and preserve action receipts if observation is unavailable. Added next-step, restart and invalid-image regression coverage; all 82 related Windows tests passed. Rebuilt candidates still require real product acceptance.

Ollama kimi-k3 returned empty answer content in independently reproduced raw streams. The cloud list now starts with kimi-k2.6; all 22 entries have not each been accepted. The installed Mac LAN request returned EHOSTUNREACH while curl succeeded; local network permission confirmation remains pending and is not a pass.
