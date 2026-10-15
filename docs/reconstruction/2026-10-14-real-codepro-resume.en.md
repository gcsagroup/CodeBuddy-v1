# Real Kimi pause, server restart, and same-run recovery acceptance

2026-10-14, current `D:\CodeBuddy-v1` source; see [source-baseline.json](source-baseline.json). This uses pinned official Harness 0.2.1-alpha.2, existing ACP controls, and the configured kimi-k3. No second model loop, dependency installation, Git operation, or external business write was introduced. Only the default provider was copied to an isolated profile; original user configuration and earlier receipts remain unchanged.

Command: Node 24 `scripts/accept-real-codepro-resume.mjs`. Actual 10:23:50–10:27:43 UTC, about 233 seconds; exit 0. [Receipt](../../.preview-evidence/real-codepro-resume-qwEdcn/receipt.json); [independent tests](../../.preview-evidence/real-codepro-resume-qwEdcn/independent-tests.log).

## Observed facts

| Stage | Evidence |
|---|---|
| Original identity | Session `62c07f46-3c6b-43e9-b311-5240e2c34bd8`; run `a4b24ed2-f603-4649-979e-549c462218b9` |
| Plan and first module | Kimi planned money → invoice-tests → verification. Native money write receipt sequence 8; successful task_result 9 |
| Pause | pause_run triggered by the actual task_result notification; pause_requested 10 and attempt_finished 11. No active attempt, pending effect, or uncertain effect |
| New server | Closed server/connection; new createCompatServer, fresh lease and session/load. Entire saved event sequence equal, same run ID |
| Resume | Existing run/control resume_run 12, attempt_started 13. Kimi read the saved module, then created invoice, tests and package.json |
| Verification | Exact local Node command approved after source review; native verification exitCode 0, successful task result 27, run_completed 28, attempt_finished 29 |
| Independent checks | 15/15 tests passed, exit 0. First module hash and mtime unchanged; original event prefix retained and its write receipt unique; no pending/uncertain effects |

Tool approvals were limited to the isolated workspace and four target files; resumed writes excluded the completed first module. Shell approval allowed only one fixed test command. All generated files were reviewed and contained local imports, node:test, node:assert/strict, and package metadata; a hash/mtime receipt bound approval to those exact files. No network, installation, or Git tools ran.

The script was subsequently tightened to validate shell workdir, run_in_background, and escalation fields. The recorded actual call used the isolated workdir and requested neither background execution nor escalation, satisfying the tightened conditions. Permission/continuity regressions passed 2/2; together with six conversation-edit tests and one ACP edit test, 9/9 passed, exit 0.

## Limits

This is actual cloud-model execution through ACP, official native tools, and real files, not scripted model replies. A persisted receipt triggered pause rather than an elapsed-time guess. Restart used a fresh server instance, without killing the host OS process or introducing artificially slow writes.

It does not establish real Electron restart behavior, macOS, tool effects during forced termination, large-repository quality, or hours-long load. The sample validates execution/recovery and is not a production finance library. Separate SIGKILL journal tests are not the same as this orderly server shutdown.

A rerun creates a fresh profile. At the fixed command approval gate it writes review-pending.json; inspect all four source files, then save that exact hash receipt as source-review.json. A nine-minute limit retains resumable state and reports interrupted rather than labeling a timeout a product defect.
