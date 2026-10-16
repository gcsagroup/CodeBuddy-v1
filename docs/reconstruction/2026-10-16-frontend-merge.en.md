# 2026-10-16 colleague frontend merge

Merge 21 commits from `origin/codex/dsh-frontend-ux` (`cead742`) into existing `main`, based on local `692f235`, with common ancestor `01610d0`. No new branch, history rewrite or Dependabot changes. Candidate version: `1.43.5`. The archived `1.43.4` installer predates this merge.

Retain automatic history loading, queued/stop-and-send messages, expired approval handling, folded execution records, historical file changes, and read-only native child catalogs/transcripts. Native children inherit the actual parent model and effort. Host limits are three concurrent children and depth one. Saved legacy role settings remain readable but do not override execution.

Resolve overlaps by preserving remote MCP reuse, asynchronous MCP tasks, deferred schemas, phase timing, Office toolbox names, GitHub account fixes and product branding. Apply permission filtering after the remote scope is bound. Preserve compatibility identifiers, user data, credentials and third-party notices. The added direct desktop dependency `diff@8.0.4` was already installed; no dependency installation was performed.

Tests now discover optional tools before use, identify child requests by their fixture prompts, trigger history intersections, use deterministic animation clocks, and create actual pending approval requests. Initial full backend run: 426/428 passed; two stale expectations were repaired and the entire affected capability file passed 25/25. The other 403 results are reused from the same run. Three-child integration, 59 presentation tests and TypeScript checking passed. The full frontend run encountered Windows memory exhaustion/worker termination; targeted serial batches replace it, not a claimed full-suite pass.

Build with `node scripts/build-harness-windows.cjs target/codebuddy-package-1.43.5/harness-distribution`. Evidence stays under local `.preview-evidence/h20-*`. Package, real-model and UI results follow below. Installed upgrade and macOS acceptance are not claimed.

## Final acceptance and artifact

All 428 backend cases have passing evidence in this batch: initial 426/428 plus the repaired 25/25 capability file and a successful native-child integration rerun. This is not a single all-green full run. Affected frontend checks passed 479+59=538 tests, plus seven separately retried Git snapshot/extension-dialog cases. TypeScript exited 0. ESLint passed after declaring the existing browser IntersectionObserver API/types; no rule was disabled. Full frontend and browser-fixture runs were interrupted after Windows memory exhaustion, not reported as passed.

Real packaged-app Kimi K3 sample: conversation visible at 710 ms, first visible reply at 5646 ms, native end_turn. A two-child project created alpha.mjs and beta.mjs, then the parent wrote verify.mjs and ran node verify.mjs with exit 0 and MERGE_SMOKE_OK, in about 35.9 seconds. Actual clicks verified the child catalog, Alpha read-only transcript, parent change panel and existing GitHub account status. GitHub MCP remained disabled in the isolated test profile.

Build exited 0; bundled Node 24.21.0, Office payload, native subprocess and service checks passed. NuGet matches the application. Artifact: `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`, 363,771,392 bytes; SHA256 `ea7771130bd05a49b0b4b2adc42cc8f958ef2a38a40b45748fbe850ffe9adbf8`. Source digest: `404fb903c175dd8fbccffb8133e5d96e41f65fd91649695aae3c3d983da443b2`. Source identity is the resolved worktree of the merge commit containing this document. Local binaries/evidence are excluded from Git. Installed upgrade, macOS and all legacy functionality remain unverified in this batch.
