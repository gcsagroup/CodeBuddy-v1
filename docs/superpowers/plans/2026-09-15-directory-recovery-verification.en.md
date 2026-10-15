# Directory recovery fixes and verification

## Confirmed defects

After renaming a self-created isolated fixture directory, the public `session/info` request failed workspace lease validation before reading database metadata. The native UI consequently displayed an English error instead of reaching the existing `session/load` reconfirmation flow.

A concurrent load for the same session also reused an earlier request despite different `cwd` or `workspaceLeaseId` values. Deterministic RED cases cover both successful and rejected earlier requests.

## Changes and boundaries

The `GetSessionInfo` handler acquires the session lifecycle lock followed by a session access permit. It reads database metadata without reading project files or acquiring or refreshing workspace leases. Tools and writes retain workspace validation. Missing and closed sessions remain rejected.

The frontend shares loads with identical parameters and serializes distinct requests, including after an earlier rejection. Different sessions remain independent. This introduces no cancellation API or permission to rebind an existing session to a different directory.

Existing sessions recover their original directory; a different directory belongs to a new task. An unavailable directory must not silently create a replacement or bind another project.

## Verification status

The related six frontend files passed 78 tests. TypeScript and ESLint exited 0. Both new backend tests passed, along with nine dispatch and twelve load regressions. The full frontend suite passed 2060 tests with four skipped. The initial backend run had one pass and one fixture failure due to a missing unique cleanup journal root; correcting the fixture resolved that failure.

Rust regressions, Clippy and the new backend build passed. Public ACP, unchanged bindings after cancellation, original-directory recovery, retry/reinspection, explicit confirmation, refresh and two native windows preserving A/B sessions passed. Eight preexisting session rows retained their hashes. The 2060-pass/4-skip full run preceded the final invalid-directory mapping and retry button; those additions passed 78 focused tests, typecheck, ESLint and native acceptance. Ten real-model turns remain NOT_RUN; neither 120 nor 107 was probed.

Evidence under `D:/CodeBuddy/.cargo/evidence/audit-fixes-20260914/`: `directory-acp-recovery-red.json`, `directory-missing-before.png`, `directory-load-concurrency-red.log`, `directory-focused-final.log`, `directory-metadata-tests-fixed.json`, `directory-source-frozen.json`.

Final evidence: `directory-native-summary.json`, `directory-acp-recovery-green-final.json`, `directory-focused-retry-final.log`, `directory-final-ui-gates.json`.
