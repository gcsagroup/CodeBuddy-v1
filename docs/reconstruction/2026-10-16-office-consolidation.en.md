# Office consolidation and merge handoff

Date: 2026-10-16. Baseline: `main` / `e9540aa8b35f5ed63a136455a52e72137fd73918`, workspace `D:\CodeBuddy-v1`. This batch delivers source and local acceptance, not an installer. The earlier [toolbox audit](2026-10-16-toolbox-audit.en.md) is a historical snapshot before removal.

## Changes

- Removed Rust DOCX/XLSX implementations, MCP registrations, argument types and two dedicated fixtures. Removed `docx-rs/umya-spreadsheet` and now-unused lockfile dependencies offline.
- Office uses existing Harness `dsh-skill-office`, bundled dependency discovery and native shell. No replacement editing service or scheduler was introduced.
- Grouped the three built-in skills under “Office documents”, retaining individual details/search. Renamed the residual extension to “PDF and web files”.
- Kept the `computercontroller` configuration key with `cache/pdf_tool/web_scrape`. User state, credentials and permissions are not migrated; historical receipts/icons remain readable.
- The Windows tool executable is now 21,777,920 bytes, previously 41,534,464. These are executable sizes, not total project or installer sizes.

## Rationale and boundaries

Legacy DOCX replacement lost images, independently reproduced in the audit. Before removal, the existing upstream payload passed image/table/bold/original preservation and the seven former XLSX operation categories. We reuse [official Harness](https://github.com/deepseek-ai/deepseek-harness) plugins/skills, retain the pinned `0.2.1-alpha.2` MIT Office plugin and existing notices, and do not upgrade upstream in this batch.

Web scraping is retained because equivalence is incomplete: pinned upstream fetch reads public text but rejects private addresses and binary content; the legacy tool also saves web files. Public text should use Harness. Missing external credentials are not evidence of useless functionality. Security MCP testing remains excluded at the user's request.

## Merge and migration

Merge this batch's commits. Resolve conflicts carefully around Rust tool registration, runtime catalog/provenance, toolbox and locales; do not restore retired DOCX/XLSX registrations. Existing `computercontroller` settings still connect its three residual tools. A same-session driver restart test confirms those tools and upstream Office skills remain discoverable. History is not rewritten or replayed. External recipes hardcoding the retired tool names must migrate to upstream skills/native shell; there is no same-name proxy retaining the old editor. Shell permissions remain authoritative.

Existing `runtime/py` and `runtime/office` payloads require no new dependencies. Fresh clones follow `scripts/office-builder/README.md`. Tool binaries are excluded from Git: build offline through the README command, copy into `runtime/tools/bin`, then update size/SHA256 from that actual artifact. Different build environments can yield different bytes. Rollback must restore source, Cargo lock, binary and provenance together without overwriting user data; it also reintroduces the old DOCX defect.

## Verification

Current source was launched through `scripts/start-harness-preview.cjs`, using existing Node 24.21.0 and configured Kimi K3 with isolated profile/workspaces.

| Check | Result |
|---|---|
| `node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs` | Exit 0; 407 passed |
| Toolbox/extensions/ACP toolbox Vitest | Exit 0; 14 files, 128 passed |
| `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | Exit 0; 69 passed, one existing network test ignored |
| Matching offline all-target Clippy with `-D warnings`, and codebuddy-tools build | Exit 0 |
| TypeScript / i18n extraction consistency | Exit 0 |
| Residual actual calls | 22 passed: PDF, three web modes, cache, eight charts and resources |
| Two-turn desktop Office and independent artifact checks | Two native completed turns; independent image-byte/table/bold/original and formula/other-sheet checks passed; upstream skills only |

Raw evidence stays locally under `.preview-evidence/h16-*`. An initial test-profile extension object had the wrong structure and was corrected. One initial conversation turn recorded user cancellation during the development hot-reload period; it is excluded from full-flow acceptance. Model missing-argument and assertion mistakes are recorded with actual retries. macOS, installers, hours-long tasks and all document layouts were not rerun. This batch does not claim to fix the known Gemma argument-compliance limitation.

Final Office session `914972d9-a0ac-46f1-9430-0750fab50550`: creation about 81 seconds, editing about 44 seconds. One missing description argument was rejected and corrected by the model; retries are not hidden. Evidence: h16-final-native.json and h16-final-independent.json. ESLint exited 0; 661 original sessions and provider/preference hashes were preserved.

Additional fresh desktop-control acceptance: Harness + Kimi K3 completed input, hotkeys, toggle clicks, cancellation, dragging and scrolling in a dedicated window (exit 0). Visible receipts included KEY-739, 12 drag moves and scrollY=40; evidence: h16-computer.log. All locale key validation and i18n compilation exited 0; existing English fallback tool descriptions in other locales were also updated.

## Colleague integration steps

1. Preserve the colleague's uncommitted work and confirm the Harness baseline above is present. A legacy Rust Agent checkout must integrate the Harness migration baseline first; copying only toolbox files is insufficient.
2. For a non-diverged checkout of this repository, run `git fetch origin` and `git merge --ff-only origin/main`. For an independently developed branch, review and cherry-pick this complete batch on the colleague's existing target branch. Do not force-push or overwrite local changes.
3. Integrate Rust removals, Cargo lock, runtime inventory, Office grouping and tests together. Rebuild tools and synchronize fingerprints, run the commands above, then perform two-turn edits/readback on Word with images/tables and Excel with formulas/a second sheet.
4. Local evidence is excluded from Git; the integrator must verify key paths in their own environment. No colleague branch was merged during this batch.
