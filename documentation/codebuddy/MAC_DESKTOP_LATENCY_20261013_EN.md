# macOS desktop messaging latency — diagnosis and repair, 2026-10-13

## Evidence and scope

Source: user-supplied session `20261013_4`, model `custom_ollama/deepseek-v4-pro:0813`. Local source: `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`; previous unrelated edits preserved. Private session/screenshots remain under ignored `target/mac-send-latency-20261013/`, outside Git.

The session spans approximately 19:02:42–19:08:22 CST and ends cancelled. It does not prove delivery of “你好”. There are 35 audited tool calls totaling 54.172 seconds, including 2.590 seconds for native desktop tools and 30.850 seconds for a temporary Swift OCR script. Nine image blocks were returned; image capture is separate from model understanding. Remaining wall time includes generation, user permission waiting and gaps; no independent network timing or model timeout is established.

Auxiliary vision was disabled, so the text-only main model lacked image interpretation. Sparse WeChat accessibility data led to OCR/shell detours and coordinate speculation. Initial Accessibility permission was absent. Later, a search popover appeared; typing Jr was rejected by focus validation, and a later click was rejected due to occlusion. The captured popover says “Search web results”; it is not verified recipient selection.

## Repairs

- `vision_service.rs`: distinguish disabled auxiliary vision as a configuration failure.
- `agent.rs`: preserve images for capable main models; when a text-only model has no vision route, provide an actionable ask_user configuration choice and explain that capture succeeded but interpretation is unavailable. Do not silently enable models or create OCR workarounds.
- `main.go` / `main_test.go`: include exact observed/active window selectors and local input coordinate bounds; retain screenshot ownership across popovers.
- `RuntimeContract.swift`, `runtime.swift`, `contract-tests.swift`: read actual AXFocusedWindow instead of equating stacking order with keyboard focus; require unique PID/geometry/title identity. Record dispatch only at native event/AX mutation boundaries. Predispatch rejection and uncertain partial input remain distinct. Pointer occlusion checks remain enforced.

Apple documents [AXFocusedWindow](https://developer.apple.com/documentation/applicationservices/kaxfocusedwindowattribute) as the application's currently focused window. A topmost nonactivating popover need not have keyboard focus. Exact behavior on the installed product still requires acceptance.

No public MCP schema, control-plane semantics, permission grants or user model configuration changed. Model guidance is not a new host authorization fact.

## Verification

Mac Go tests and vet: exit 0. Swift contract tests and complete native helper compilation: exit 0, covering nonactivating popovers, focused dialogs, ambiguous/wrong-process identities and dispatch boundaries. Packaging tests: 15 passed.

Rust: `cargo test -p goose --lib FILTER --jobs 1 --locked --offline`, with filters `unavailable_vision_keeps` (1), `agents::vision_service::tests` (25), and `text_only_model_context` (2), all exit 0. Ran `cargo fmt --all`.

Mac release backend build, `bundle-macos.cjs`, and `macos-install-smoke.cjs` exited 0. The installation smoke uses isolated fixtures, not the real WeChat flow. All 2054 build inputs match the local checkout by hash. Remote Git base is `c3a537517a464053d090bc1983bafeddd00a79df + dirty`; interpret its manifest together with the local revision and source synchronization records.

Installed `/Applications/CodeBuddy.app`; previous application retained at remote repository `target/mac-send-latency-20261013/CodeBuddy-before-latency.app`. User profile retained. Remote desktop installer: `CodeBuddy-Mac-20261013-desktop-latency/CodeBuddy-arm64.dmg`; local copy: `target/mac-send-latency-20261013/delivery/CodeBuddy-arm64.dmg`.

DMG SHA256: `a90b6b92a14fda71339e5f786043dd10236ba42a6d7f72ff7a09b30e3661925e`. Backend SHA256: `839143ec4f8677dfea3e57281c22568178dbe705976e8d77be056b1e74099711`. Apple Silicon ad-hoc internal test package; Intel and Developer ID notarization not accepted.

**Product acceptance blocked:** at 19:49 CST the OS reported `CGSSessionScreenIsLocked=Yes`; RustDesk retained the old 19:34 image. User unlock requested. Actual missing-vision questions, WeChat search focus, and image recognition remain unverified. No external message sent, and no auxiliary model settings changed.

Acceptance cases: missing vision prompts the user instead of OCR detours; configured vision reads the actual window; search popovers retain the correct keyboard target; occlusion/focus rejection reports no dispatch; uncertain sends are never replayed. Real third-party sends require fresh recipient/content confirmation. No commit or push in this change.

## Follow-up after unlock (20:50)

- The user requested `Ollama / kimi-k3` for all tests. Both real application switch attempts failed during model discovery with `Connect, TimedOut`, before image analysis.
- Independent requests sometimes returned HTTP 200. A three-second HTTPS connection limit reproduced SSL connection timeout; a separate 15-second probe also timed out. The short client deadline and intermittent network failures are separate findings.
- `acp/server/providers.rs` removes the separate three-second connection cap while retaining the 30-second overall request timeout and credential/model validation. The slow connection regression passed: one test, exit 0, 3.22 seconds.
- The user approved a host-owned question and pause. `agent.rs` preserves typed vision errors and uses the existing ActionRequired channel to ask how to resolve a missing image route. No further model/tool calls run while waiting; retry rechecks configuration. Historical images do not block a newer request, and capable main models retain pixels.
- Existing elicitation semantics are reused, without a new public protocol or automatic permission grants. Reference: [MCP elicitation](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/client/elicitation.mdx).
- New regressions and desktop acceptance are pending. The installed package remains the SHA256 version listed above; Kimi K3 has not successfully been selected and is not accepted as passing.


## Additional verification (21:13 CST)

- Rust `vision_configuration_`: 3 tests passed; `provider_persistence_tests`: 11 passed, exit 0. These cover rejection-to-question routing, no further provider calls while waiting, cancellation cleanup, historical images, and capable main models.
- `cargo clippy -p goose --lib --jobs 1 --locked --offline -- -D warnings`: exit 0. `cargo fmt --all` completed.
- Frontend ElicitationRequest: 4 passed; ACP elicitationRequests: 5 passed. Node 22 versus the package Node 24 requirement remained a warning; no environment changes. An initial extra `--` prevented intended filtering; that process was stopped and the correctly filtered runs passed. The stopped run is not pass evidence.
- All 2054 build inputs match across Windows and Mac. New Mac build is running. At 21:13 the OS again reported screen locked, while RustDesk retained its 20:30 image; product acceptance awaits unlock and installation.


## New package delivery (21:29 CST)

- Release backend, bundle, and installation smoke all exited 0. Installed `/Applications/CodeBuddy.app` passed strict codesign verification.
- arm64 / 1.43.2 / ad-hoc package: remote Desktop `CodeBuddy-Mac-20261013-vision-pause/CodeBuddy-arm64.dmg`; local `target/mac-send-latency-20261013/vision-pause-delivery/CodeBuddy-arm64.dmg`.
- DMG SHA256: `bd667cf618d240ed63cc1ad16d7325a25f72f8cb856a9574b99e86020c9cab45`; backend: `fdabb89890c7a00ac36e04735ea08c29f98b35dd431aac8b3582b1149538af49`. This candidate includes the host question/pause and connection deadline fixes, superseding the earlier package.
- Old app backup: remote repository `target/mac-send-latency-20261013/vision-pause/CodeBuddy-before-vision-pause.app`. User profile preserved. Source: local main / 964bbeb1587f1c5551ee17907e0b26632c4163ce plus dirty changes; 2054 build inputs match.
- Desktop was unlocked at 21:19 but automatically locked again at 21:27, confirmed at 21:29. New process started, with no renderer-ready evidence yet. User unlock requested again. Real Kimi K3 switching, image understanding, and recovery remain pending. No external sends, commit, or push.


## Desktop acceptance after unlock (23:21 CST)

- The new `/Applications/CodeBuddy.app` started at 22:49 and reached React readiness. Evidence uses its `20261013_224941.log`, excluding the concurrently running old test application.
- **Real UI model switching passed**: settings and the new chat show `Ollama / kimi-k3`; session `20261013_5` persists `custom_ollama / kimi-k3`. Discovery returned 18 models in 1016 ms.
- A read-only observation request was submitted through the actual UI. `list_apps` triggered the macOS CodeBuddy Screen Recording authorization dialog. The receipt identifies `/Applications/CodeBuddy.app` as lacking permission; no desktop input was dispatched.
- The run explained the permission blocker and asked for next steps, without repeated screenshots or external messages. This proves this run's model request/response and permission error feedback. **Image recognition was not reached; the new host vision-configuration question path was not exercised.**
- User action on the system privacy prompt is pending. Real image recognition, host vision-question UI/recovery and the WeChat focus flow remain unaccepted. Documentation-only update; no rebuild, commit or push.

## 2026-10-14: enabled Screen Recording switch still denied

- At 10:48:35, macOS tccd attributed the request from `/Applications/CodeBuddy.app/Contents/Resources/bin/qwen-computer-runtime` to the correct responsible application, `local.codebuddy.desktop`. It explicitly logged `Failed to match existing code requirement ... kTCCServiceScreenCapture`.
- The stored grant required `cdhash 5b9ee82b0866b12ff00e2bfbd26119fa3a6eff2c`; the installed application had `cdhash 8e849af0e426fc06e6b114ba5c999fce1eb272b0`. The old TCC grant no longer matched the updated ad-hoc signature. This failure occurred before image capture, independently of model vision or network timeouts.
- A separate copy started from `/Volumes/CodeBuddy 1/CodeBuddy.app` after 10:53. This confounds subsequent tests but does not explain the earlier failure from the installed application. A later process check confirmed `/Applications/CodeBuddy.app`.
- After the user explicitly requested removal, `tccutil reset ScreenCapture local.codebuddy.desktop` exited 0 and reported success. Only CodeBuddy Screen Recording approval was reset; no TCC database, other application permission, or system protection was edited. User authorization of the current installed application remains required.
- Updated `RuntimeContract.swift` guidance distinguishes process denial from an off switch, explains stale signing entries and removal/re-addition, and identifies installer-volume copies. It no longer repeatedly recommends toggling the same stale entry.
- The Swift contract suite was compiled and run in the existing remote checkout using the commands from `build-macos-computer.cjs`, exit 0. This guidance change has not been repackaged or installed over the application currently being authorized; the candidate DMG remains the hash recorded above.
- No valid Developer ID Application identity was listed on this machine. Stable, appropriate signing credentials and release configuration are needed for identity continuity across distributed updates; the ad-hoc test package is not a Developer ID release. See [Apple TCC guidance](https://developer.apple.com/forums/thread/730043).
- Local and remote evidence: `target/mac-permission-20261014/tcc-signature-mismatch.log`. Source baseline: `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`. Existing changes preserved; no commit or push. Real screenshot/vision acceptance after renewed authorization remains pending; a successful reset is not product acceptance.
