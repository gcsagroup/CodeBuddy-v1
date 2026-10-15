# Harness packaging and response phases, 2026-10-15

In progress; installed-product acceptance is not yet claimed. Read-only Undici diagnostics now separate request creation/send/body completion/response headers, first reasoning, first text, and completion without changing fetch, retry, effort or stream content, and without logging secrets. Identical kimi-k3/high/55-tool/52433-byte request comparison: Compat first text7760/6470ms; native Harness4330/3820ms. These are cold runs. Minute-long latency did not recur; earlier slow samples remain valid.

Electron utilityProcess hosts the existing Harness runtime, with native shutdown and no fallback to the retired agent. Existing Forge/Squirrel packages official dependencies, adapters, recipe schema and verified Rust MCP tools, with SHA256 manifests. Separate CodeBuddyHarness install ID and ~/.CodeBuddy-Harness data. Build using existing Node24: node scripts/build-harness-windows.cjs. No user data or credentials are shipped; no dependency installation.

Passed: transport5/5, service2/2, distribution36/36, TypeScript/lint exit0. Real Electron41.1.0/Node24.14.0 utility startup/status/shutdown exit0. Fixed log-close race. Packaging exposed Vite watching a locked out/EXE and exiting EBUSY; out is now excluded, live watcher recheck pending. After old preview exit, an exclusive profile lease protected a copy of637 sessions/config into the new installed profile, verified identical hash, schedules paused, source preserved.

Installer fingerprint and installed model/tools/restart results pending. macOS artifacts remain separate. Official design references are linked in the Chinese document.

## Installer build fixes

The first make process left no exit receipt and is not a pass. Resuming the unchanged packaged application with the official Forge --skip-package option produced a concrete NuGet Windows path-length failure, exit1 (harness-installer-make-retry.log). The full CLI tree included inactive experimental-inspector paths up to 190 relative characters. Staging now derives roots from ESM imports and the actual profile and follows runtime, peer and present optional dependencies. Nested versions, licenses and runtime assets remain; development dependencies, declarations and source maps are excluded. The dependency regression passed 1/1, exit0, covering nested versions, cycles, peers, absent optional and missing required dependencies. Parent-level shared bufferutil packages retain their original Node resolution layout.

The real Vite watcher observed source fixture add/change events and ignored the output fixture, exit0 (vite-watch-receipt.json). Renderer UI behavior was not changed.

## 10:46 installed regression and repair

The 1.43.2 installer completed a real silent install with exit0 under LOCALAPPDATA/CodeBuddyHarness. Installed EXE, app.asar and Harness manifest matched the candidate, but startup failed because dependency discovery omitted the adapter direct import of dsh-schedule. This installer is not a usable delivery. It is preserved under target/failed-harness-installer-1.43.2; test processes were stopped and user configuration retained.

Staging now also scans top-level adapters for relative Harness package imports, including scheduling and WAV validation, and follows the adapter runtime dependency closure. The new pre-package gate starts the complete Compat service and a native session. It reproduces the old stage failure (stage-service-red.log). The repair candidate is 1.43.3-harness1; rebuild, actual upgrade, conversations and restart continuation are pending.

The separate Squirrel environment defect was also repaired: its existing vendor had architecture-specific 7-Zip files but lacked the generic names Squirrel launches. A project-local vendorDirectory stages existing tools without changing dependency directories. NuGet resume verifies application and Harness identity, closes the ZIP and uses a separate input path. Latest related gates passed 38/38, exit0 (harness-package-final-gates.log).

## 11:10 first-send admission regression

The dependency-complete candidate booted and displayed retained history/settings. Its first project prompt failed before any model request because sidebar tool polling held the conversation adapter lock. Sending now reserves the next admission and waits for existing tool maintenance; further polling cannot starve it. Cancellation while waiting never submits a model request, and edit/delete protection remains. Two regressions failed before the fix; related tests passed 24/24. The added native Harness maintenance/streaming integration group passed 11/11, exit0. Harness still owns execution, scheduling and completion.

Rebuilding the corrected installer in harness-installer-admission.log. The 10:58 timing included input actions during package compression and is not an idle latency result. Installed-product acceptance remains pending.

## 11:28 installed native subprocess host failure

The harness1 upgrade exited 0 and installed identities matched, but real tools exposed an Electron utility host defect: native Harness Job runners inherit process.execPath and launched CodeBuddy.exe instead of Node. PowerShell and glob failed, so harness1 is not an accepted delivery. The replacement bundles the existing Node 24.18.0 executable and LICENSE, using native IPC supervision without changing Harness scheduling. Canonicalizing the trusted distribution root also handles Codex MSIX LocalCache redirection while retaining file identity checks.

Candidate 1.43.3-harness2: service tests 2/2, TypeScript and relevant lint exit0. The pre-package gate now executes PowerShell/glob with bundled Node. Full installed acceptance remains pending; log harness-installer-node-runtime.log. The valid warm UI sample entered the conversation in 1.02s and displayed output in 8.09s; preparation 754ms, first upstream data 4629ms. The original warm.json probe read retained hidden DOM and is invalid; use warm-v2.json. The physical-path greeting requested installation verification and triggered tools, so it is not a pure greeting latency sample.

## 11:41 shutdown race and replacement candidate

Bundled Node passed native PowerShell/glob and full-service alias, authenticated health, and exit checks. The candidate UI completed actual time and PowerShell model tool calls. A plain greeting entered in 1.31s and displayed output in 6.14s. Closing an ACP-connected desktop still reached the 15s fallback. A red regression proved that shutdown accepted reconnects; rejecting new HTTP/upgrades after shutdown starts fixed the tested race, with 10/10 related tests passing. Candidate is now 1.43.3-harness3, building in harness-installer-final.log; final installed acceptance remains pending.

## 12:06 final installed candidate

Source is the existing D:\CodeBuddy-v1 tree with local changes; no .git, branch, commit or push. Build and actual silent upgrade exited 0. Seven installed executable/archive/runtime/tool hashes match the candidate. Separate install ID CodeBuddyHarness; launch `%LOCALAPPDATA%/CodeBuddyHarness/app-1.43.3-harness3/CodeBuddy.exe`, data at `~/.CodeBuddy-Harness/backend`. The MSIX redirected root is canonicalized; the old shortcut is preserved.

A plain greeting entered in 1.698s, first visible response in 11.400s with incremental rendering. Cold preparation took 5149ms and upstream first text 2657ms: cold latency remains. The next project session prepared in 948ms and reused remote MCP. The installed UI completed money/tax/invoice in 145.5s. Model tests initially passed 33/34; it corrected its own invalid floating-point sanity assertion and passed 34/34. Independent host rerun passed 34/34 and external contract 7/7, exit 0. Native turn/end reports completed. Project memory remains a review candidate.

The existing Compact now button completed native compression in about 26.35s, updating 23k to 17k (16925/32768). Typing /compact then Enter was intercepted by the slash menu and is not a passing path. Normal close returned in 220ms; desktop, Node and recorded MCP processes exited. Restart reopened history with confirmation of its saved workspace before continuation.

Batch gates: native admission/lifecycle 11/11, shutdown/lifecycle 10/10, delivery 40/40, service 2/2; TypeScript, targeted lint and build exit 0. Changes cover conversation admission, shutdown reconnect rejection, bundled Node IPC, complete runtime dependencies, real subprocess preflight and Squirrel finalization. Detailed paths/commands are in the Chinese record. Evidence: `.preview-evidence/harness3-installed-*.json`, project/independent test logs, harness-final-install.json. No development dependencies were downloaded or installed. These Windows installed tests do not establish macOS, repeated automatic compaction, or hours-long production-scale project acceptance.


- Version: `1.43.3-harness3`
- Installer: `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Harness-Setup.exe`
- SHA256: `9D4EA185DF6861188743CC6905E898E0FB360391A4D9F87EC1A7896AB708627E`
- Harness sourceDigest: `cd5443c4d6cb2c3d729596ac42895891531d7782793e6cf6774cf23a1a862c78`

## 12:10 restart continuation and timing

The original session continued in about 28 seconds, retaining HARBOR-625, 625 bp, untaxed shipping and 10975. Actual tools passed 34/34 tests and printed 11050 for the new 700 bp parameter. Native turn two completed; six source/test file hashes are unchanged. The final new-chat greeting entered in 1.332s, showed output in 8.054s and stabilized in 10.347s; MCP reused, preparation 1433ms, upstream first text 2534ms. First visible output still takes 8–11s in these two samples; unmeasured timing gaps are not attributed solely to the provider. Evidence: harness3-installed-resume.json, harness3-installed-warm.json, harness3-project-resume-hashes.json. The installed app remains running.
