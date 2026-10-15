# Built-in tools connected through Harness MCP

This batch adds `runtime/builtin-extensions.mjs` in `D:\CodeBuddy-v1` while preserving the renderer. No branches, commits or pushes were created; this directory has no Git repository. The new Harness and compatibility layer continue to own model inference, sessions, scheduling and tool permission. Existing executables run only fixed standalone stdio MCP entrypoints, without the legacy agent, ACP server or scheduler.

## Adapter contract

`builtinMcp(extension,{cwd,dataDir})` and `toTestExtension(...)` are async. The following `type: builtin` definitions produce official `dsh-mcp-client` configurations; other types return `undefined`. `isBuiltinMcp` identifies this module's extensions; `builtinToolNames(name)` returns original tool names verified for the pinned artifacts. `listAvailableBuiltins()` returns `{configKey,enabled:false,available,reason?,extension}`. Availability means platform and artifact validation; live discovery still uses `driver.testExtension`.

| Existing UI extension | Fixed entrypoint | Actual discovery in this batch |
| --- | --- | --- |
| `qwen_computer` | `qwen-computer-use.exe --foreground-input mcp` | 9: click, drag, get_app_state, list_apps, perform_secondary_action, press_key, scroll, set_value, type_text |
| `computercontroller` | `goose.exe mcp computercontroller` | 5: cache, docx_tool, pdf_tool, web_scrape, xlsx_tool |
| `autovisualiser` | `goose.exe mcp autovisualiser` | 8: render_chord, render_donut, render_map, render_mermaid, render_radar, render_sankey, render_treemap, show_chart |

Model-facing names are `mcp__<extension>__<tool>`. The session compatibility layer consumes permission, enable switches and tool allowlists. Additional command/args/env fields cannot redirect built-in entrypoints. SHA256 is checked on first use and again after the artifact's identity, size or modification metadata changes.

## Artifact provenance and directories

Both executables were copied from the original project's `D:\Users\jiangrui\Desktop\CodeBuddy\ui\desktop\src\bin` into `runtime/tools/bin`, with SHA256 verified before and after copying. `runtime/tools/provenance.json` records exact sources, times, sizes and license hashes.

- `goose.exe`: 331,956,224 bytes; SHA256 `8186e7eb25a45e93d4ba29a4b56a1230985a30d5a9b8a7843f571a683f1d8b13`. The original workspace and root LICENSE declare Apache-2.0. Full text is preserved in `runtime/tools/licenses/goose-Apache-2.0.txt`.
- `qwen-computer-use.exe`: 4,736,000 bytes; SHA256 `5b08525ee3825d611a4ef643badbdf15dd55e95816e4f5f15fd06dbe30c5f9b8`. Its source directory contains an MIT license, preserved in `runtime/tools/licenses/qwen-computer-use-MIT.txt`.

These are existing tool artifacts, not binaries rebuilt by this batch. Source baseline revision is `964bbeb1587f1c5551ee17907e0b26632c4163ce` plus uncommitted changes; reproducible correspondence between that source and the existing binaries has not been established. These permissive first-party licenses allow reuse with their license and notice obligations retained. A transitive third-party notice inventory remains a release packaging requirement. Terms: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0), [MIT](https://opensource.org/license/mit).

The child environment redirects legacy CLI logs, project tracking, user configuration, caches and temporary directories to `dataDir/tool-runtime/<extension>`. Parent environment values are unchanged. `CODEBUDDY_HOME`, legacy path aliases, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/TMP and XDG paths are isolated. Legacy telemetry is disabled. Explicit document outputs still go to the workspace or user-selected location; environment redirection is not a filesystem sandbox.

Computer actions retain the original tool behavior: `--foreground-input` restores the observed target window before input, and existing `OPEN_COMPUTER_USE_*` controls remain inherited. The adapter does not impose additional launch, focus or text-fallback restrictions. Initialize/tools/list alone dispatches no desktop input.

## Verification and limits

`node --test runtime/tests/builtin-extensions.test.mjs` ran under the existing Node.js 24 runtime: 3 passed, zero failed, exit code 0. Temporary-directory tests cover artifact/platform validation, fixed commands, child environment isolation and unchanged parent environment. The official Harness started all three actual servers and discovered 22 tools. Tests verified legacy CLI logs and document/chart caches under the isolated directories. No tools/call, mouse action, keyboard input or user-process termination occurred.

Artifacts currently cover Windows x64 only. macOS explicitly reports missing platform artifacts. This record does not establish document-editing, computer-action, real-model or desktop E2E acceptance. The main integration batch records subsequent tool-call validation separately.
