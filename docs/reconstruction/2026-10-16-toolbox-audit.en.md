# Toolbox acceptance report — 2026-10-16

> [Follow-up: implemented Office consolidation and current acceptance](2026-10-16-office-consolidation.en.md)。
Source: `D:\CodeBuddy-v1`, branch `main`, revision `e9540aa8b35f5ed63a136455a52e72137fd73918`. Desktop checks used the corresponding H15 local application at `ui/desktop/out/CodeBuddy Harness-win32-x64/CodeBuddy.exe`, with isolated profiles and workspaces. This is not acceptance of a newly built installer.

## Results

All 25 built-in MCP tools have actual invocation evidence: 24 passed representative scenarios; legacy `docx_tool` has confirmed image loss and is not counted as passing. This is tool coverage, not coverage of every parameter combination. See the [sanitized per-tool CSV](2026-10-16-toolbox-audit.csv) for explicit evidence levels and exclusions.

| Capability | Evidence and outcome | Recommendation |
|---|---|---|
| Native files, commands, images and fetch | Actual `read/write/edit/working_directory/glob/grep/read_image/pwsh/web_fetch` calls with fixture result checks | Retain |
| Deferred discovery, dependencies and skills | Actual `search_mcp_tools/load_workspace_dependencies/skill` calls | Retain Harness mechanisms |
| Common queries (3) | Time, location, current weather and two-day forecast using resolved coordinates | Passed; ambiguous location requests are expected behavior |
| Computer control (9) | Real-model entry, typing, keys, toggle, dialog cancellation, drag, scroll, save and finish; main vision and auxiliary fallback | Scenario passed with model argument stability caveat |
| Charts (8) | Real-model calls, resource reads, eight desktop guest frames containing SVG/Canvas/text, and a desktop screenshot | Basic rendering passed; not every interaction or export |
| Legacy DOCX | Successful text-replacement response, but independent inspection found image count fell from 1 to 0 | **Defect; prioritize migration to upstream Office** |
| Legacy XLSX | Seven operation types; independently checked changed value, preserved formula and other sheet | Fixture passed; consolidate only after compatibility migration |
| PDF, web scrape, cache | PDF text/embedded-image extraction; local HTTP text/json/binary; isolated cache list/view/delete/clear | Basic scenarios passed; no OCR, complex PDF or arbitrary-site guarantee |
| Upstream DOCX/XLSX | Fresh upstream regression tests; reused real-model evidence from the same revision for image/bold, formula/other-sheet and original preservation | Retain; reused evidence is distinct from fresh E2E |
| Upstream PPTX | Kimi created two slides, edited slide one, preserved slide two and original; independent artifact check | Content passed; visual layout untested; Gemma run incomplete |
| Custom skill | Create/list/run A/update B/disable/enable/restart/run and retained conversation facts | Passed fixture; first turn read the skill from the workspace, not proof of automatic catalog injection every time |
| Git, memory, library, goals and task capabilities | Six relevant test files: 49 passed, zero failed/skipped | Integration coverage; not individual desktop E2E for every underlying tool |
| Exa | Both tools returned real search/fetch results | Retain |
| Tavily | Search/extract passed; crawl/map/research require API key | Last three are configuration gaps; existing disabled state unchanged |
| Official GitHub MCP | Missing `CODEBUDDY_GITHUB_MCP_TOKEN` | Configuration required; no repository operation tested |
| External security MCP “1” | 150 discovered tools; health/cache status only. Server reports 74 available and 50 missing dependencies out of 124 | User explicitly deferred further tests; dependency counts are not tool pass counts |
| Managed compatibility entries | `tom/code_execution/summarize/todo/apps` | Names do not establish duplicate engines or useless code |

## Findings and removal candidates

Legacy DOCX `do_replace` in `crates/goose-mcp/src/computercontroller/docx_tool.rs` creates a new document, copies paragraph text runs and overwrites the original. Images are not retained. Other non-text nodes also lack preservation in this path, but only image loss was independently reproduced here. Migrate callers to existing `office-docx`, resolve historical compatibility, then retire the old implementation. Do not remove the entire `computercontroller` extension and accidentally lose PDF, cache and scraping capabilities. This old extension was already disabled in the user profile; this audit did not change that setting.

Gemma repeatedly omitted required `pwsh.description` in the PPTX scenario, producing `INVALID_ARGS`; the fixture reached its 20-turn cap without artifacts. This is incomplete acceptance, not proof the Office library is broken. Kimi completed the same task. The first desktop drag attempt supplied coordinates as strings; repeating with an explicit JSON-number instruction passed. The initial instability remains recorded; model claims about the bridge were not treated as facts.

Tavily returns `isError:false` even when its text requires an API key. Those operations are classified as configuration-required. Missing credentials or remote dependencies do not justify deleting capabilities. Legacy DOCX is the first retirement candidate; XLSX/scrape overlap needs compatibility comparison first. Retain PDF, cache, desktop, charts, native development, Git, memory and skills. No blanket tool deletion is supported by these results.

## Verification and evidence

Local evidence is under `.preview-evidence/` and excluded from commits. Raw sessions, credentials and MCP URLs must not be published.

- `toolbox-20261016/execution.json`: initially 52 calls, 48 PASS / 4 FAIL. Four fixture errors lacked image modality or common-query metadata; corrected reruns are in `retest.json/followup.json`.
- `toolbox-20261016/docx-image-regression.json`: independent 1→0 image reproduction; `cache.json`: isolated cache lifecycle.
- `real-computer-main-Insa79/receipt.json`: main vision passed; `real-computer-auxiliary-Z87J3T/receipt.json`: seven fallback observations and visible postconditions passed.
- `real-skills-6sDNmz/receipt.json`: custom skill lifecycle; `toolbox-20261016/pptx-kimi/independent.json`: independent PPTX inspection.
- `toolbox-20261016/charts-ui.json/charts-frames.json/charts-ui.png`: eight rendered charts, completed in 27.3 seconds. Later additional screenshot capture exited 1 because target frames were not found on the current page; this extra capture is incomplete and does not replace the earlier evidence.
- `toolbox-20261016/external-calls.json/tavily-calls.json`: actual external results classified by their contents.
- `h15-user-preservation-after.json`: all 661 original sessions retained; provider/preference hashes unchanged; preservation command exited 0.

Scenario runners are `.preview-evidence/toolbox-{execute,followup,cache,computer-numeric,computer-entry,custom-skill,pptx-kimi,charts-ui,external-call,tavily-call}.mjs`; the auxiliary desktop runner takes `auxiliary`. Successful runner exit codes do not mean every returned operation passed: independent artifact validation overrides the legacy DOCX success response. Additional chart capture failure is listed separately.

```powershell
node --test runtime/tests/git-write-acp.test.mjs runtime/tests/memory.test.mjs runtime/tests/library.test.mjs runtime/harness/test/upstream-tools.test.mjs runtime/harness/test/capabilities.test.mjs runtime/harness/test/goals.test.mjs
```

Exit 0; 49 passed, zero failed/skipped. Existing Node 24, project Python and offline-cached Tavily were used; no dependencies installed. No tools deleted, product source changed or installer built. These reports are local and not committed/pushed. macOS, installers, repeated long-task compaction and every frontend entry were not rerun. The DOCX defect and model argument problems remain unresolved by this audit; the report does not claim the whole first release passes.
