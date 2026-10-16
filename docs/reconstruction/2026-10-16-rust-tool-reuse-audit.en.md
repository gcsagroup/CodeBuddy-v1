# Rust tool replacement: upstream Harness capability audit

Date: 2026-10-16. Workspace: D:\CodeBuddy-v1, main / 01610d03764570282eee439cd2bfb49fcd373e98 with existing changes. Investigation and documentation only: no product runtime change, tool removal, dependency installation, commit or push.

There are worthwhile upstream components, but no identified complete, direct, lossless replacement set for the remaining sixteen Rust MCP tools. Prioritize upstream Office workflows and public-page fetching. Keep other capabilities accessible through Harness MCP rather than building new document, chart or weather engines merely to eliminate Rust.

## Evidence

- Installed Harness is pinned to 0.2.1-alpha.2. The complete official tree examined was 86a402200d95fecef4529d969836f1fe13c6cb0d: 18,673 entries, not truncated. The latest computer-use manifest read reports 0.2.1-alpha.4; current upstream and installed packages are different baselines.
- A temporary isolated Harness session connected to all three real Rust MCP services: three time/weather tools, five document/web/cache tools, eight visualization tools. Inventory script exited 0. No model request, desktop input or user-file modification occurred.
- Filesystem, search, PowerShell, jobs, subagents and skill infrastructure already use upstream Harness and are outside this remaining inventory.

## Capability matrix

| Existing capability | Upstream candidate and decision |
| --- | --- |
| docx_tool: extraction, append/replace, structured styles, images | dsh-skill-office Word workflow uses python-docx. Reuse candidate, not a drop-in API. Verify existing formatting, images and untouched content before retirement. |
| xlsx_tool: sheets, columns, ranges, search, cell read/write, save | Excel skills use openpyxl/pandas, with LibreOffice Kit for recalculation. Verify formulas, styles, multiple sheets and persistence. DataFrame export is not workbook-preserving replacement. |
| pdf_tool: text and embedded-image extraction | Office-to-PDF converts Office inputs; read/read_image do not provide the equivalent PDF extraction contract. Retain. |
| web_scrape: text/json/binary download into resource cache | Official web_fetch can replace public text retrieval. Its HTTP provider rejects private destinations and binary bodies and does not return the old cached-resource contract. Partial overlap only. |
| cache: list/view/delete/clear | FS, MCP resources and delivery offer reusable foundations, but existing cache identities and historical resources require compatibility work. Not a direct replacement. |
| time_now: immediate structured IANA timezone query | dsh-time-context injects step context, default minimum interval ten minutes. This is different from a requested structured clock tool. |
| location_resolve and weather_get | No equivalent provider identified in the examined official package inventory. Search does not preserve default-city settings, network enablement, units, dates, cache or rate-limit semantics. |
| render_chord/donut/map/mermaid/radar/sankey/treemap and show_chart | present delivers files; it is not a chart generator or equivalent embedded MCP App renderer. Retain the existing eight tools instead of rewriting templates. |

Office, web and present packages are visible in installed dependencies but not mounted by the current profile or exposed in the live inventory. Office workflows require an application-owned interpreter/library payload and load_workspace_dependencies; Codex's private runtime is not a distributable product dependency. Adding Python/Office payloads may offset removal of the approximately 41.5 MB Rust tool executable.

## Computer control and migration gates

The current qwen-computer-use.exe is a separate artifact, outside those sixteen tools. Upstream experimental Cua Driver MCP/native plugins merit separate evaluation. They require platform driver/permission support; the native plugin depends on @trycua/cua-driver 0.28.0, not a native-free implementation. Upstream screenshot admission requires image input and does not directly establish CodeBuddy's main-model-first, auxiliary-vision fallback contract. Preserve the existing vision routing and verify focus, input, cancellation, cross-session serialization and Windows/macOS permissions.

The Rust crate also contains MemoryServer and platform automation definitions not exposed by the current three-service entry point. Live inventory has no old computer_control, automation_script or Rust memory tool. Removing unreachable source is separate cleanup, not evidence of a functional upstream replacement; no such deletion occurred here.

Recommended order: mount pinned upstream Office workflows and public fetch through existing lazy discovery; reuse official skills, libraries and carrier payloads; keep CodeBuddy responsible only for path/settings/delivery adaptation. Verify DOCX preservation, XLSX formulas/styles, public text/JSON/binary/private-web/cache behavior with automated checks and actual installed-product tasks before retiring each old interface. Keep codebuddy-tools while PDF, weather or charts need it. Evaluate new dependencies, package versions, licenses and platform artifacts separately rather than silently mixing alpha versions. Upstream packages examined are MIT; existing goose tooling is Apache-2.0, and carrier dependencies require their own notices.

This is source/contract analysis plus real MCP inventory verification, not replacement E2E acceptance. No new installer was produced; Harness14 is unchanged. Local evidence is under .preview-evidence/rust-tool-reuse-inventory.json, harness-tool-audit-upstream-tree.json and audit-upstream-*, excluded from commits.

[Simplified Chinese full report and source links](2026-10-16-rust-tool-reuse-audit.zh-CN.md) · [Traditional Chinese](2026-10-16-rust-tool-reuse-audit.zh-TW.md). Official references: [Office skills](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/skill/skill-office), [web packages](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/web), [Cua Driver provider](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/experimental/computer-use-cua-driver-native).
