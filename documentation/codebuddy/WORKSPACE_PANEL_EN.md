# Workspace panel delivery notes

Date: 2026-09-30. Base: `main`, `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`. Acceptance ran from the existing checkout with these changes.

## Behavior

The right task sidebar now opens workspace files, interactive terminals and embedded browser tabs. It supports resizing, expansion and collapse. Files offer a tree, filename search, Markdown/image/text previews, editing and saving. A changed disk version rejects the save and retains the draft. The existing confirmation component handles draft discard and terminal close.

Terminals reuse MIT packages `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0` and `node-pty@1.1.0`, starting PowerShell in the current session workspace. Browsing uses Electron WebContentsView with HTTP/HTTPS navigation, history and reload. Guest pages have sandboxing enabled and no Node or application preload access.

The existing ACP snapshot supplies workspace identity. Renderer state owns tabs/drafts; the Electron main process owns terminal/browser resources scoped to application windows and sessions. Switching conversations retains resources; window closure and renderer reload dispose them. This feature does not require a Rust rebuild.

## Integration

Implementation and tests: `ui/desktop/src/workspace-panel/`. Existing entry points: `AppLayout.tsx`, `main.ts`, `preload.ts`. Dependencies: desktop `package.json` and `ui/pnpm-lock.yaml`. Forge uses the bundled Windows Node-API prebuilds and unpacks node-pty files. Locale additions are in English, Simplified Chinese and Traditional Chinese.

The checkout also contains previous Git MCP work; review and commit changes by feature.

## Validation

From `ui/desktop`, `pnpm exec vitest run src/workspace-panel src/components/Layout/AppLayout.test.ts --maxWorkers=1` passed 23 tests, exit 0. TypeScript and targeted ESLint passed. Coverage includes real temporary files, Chinese/BOM/CRLF, concurrent and stale saves, traversal/junction rejection, binary/size boundaries, draft isolation and confirmation behavior.

Real Electron acceptance used the official `start-gui-debug` entry and session `20260930_31`: Chinese file editing/saving; PowerShell cwd and actual Unicode file output; Ctrl+C followed by another command; confirmed terminal closure; cross-session resource rejection; local webpage links/history/reload; draft and terminal-output retention across conversation switches. Guest `require` and `window.electron` were both undefined.

Local evidence: `D:\CodeBuddy\.cargo\workspace-panel` (`tests.log`, `file-ui-result.json`, `terminal-evidence.json`, `switch-evidence.json`). Evidence fixtures are not committed.

## Limits

This is development-desktop acceptance; a rebuilt installer has not been tested. Drafts/tabs persist in renderer memory across conversation switches, not application restarts. Unsaved drafts block closing/reloading until saved or explicitly discarded. Text editing is limited to 2 MiB; filename search skips dependency/build folders and bounds result counts. Manual terminals are separate from agent shell authorization.

The repository-wide `i18n:check` has existing English catalog drift: five extra `currentPlan.*` keys and five changed `toolAction.*Summary` values. New `workspacePanel.*` messages match extraction; the existing check is not reported as passing.

References: [xterm.js](https://github.com/xtermjs/xterm.js/), [node-pty](https://github.com/microsoft/node-pty), [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view).

## 2026-10-08 presentation update

Using the user-supplied DeepSeek Hermes screenshots as a visual reference, files, terminals and browser views now share compact tabs, toolbars, spacing and thin scrollbars. File previews hide the explorer by default with an explicit toggle. Existing react-syntax-highlighter provides syntax colors, line numbers and wrapping; files above 100,000 characters retain full plain-text content to bound tokenization cost. Terminals follow the app theme, expose the working directory and process status, and provide display-only clearing and minimum text contrast. Browser address bars, empty pages and loading states are restyled; the native blank view stays hidden so it does not cover the empty-page instructions.

Changes are limited to src/workspace-panel components, CSS, component tests and three locale catalogs. No dependencies added. Existing file-version checks, terminal processes and browser permission policies are retained.

Verification in ui/desktop: pnpm exec vitest run src/workspace-panel --maxWorkers=1 passed 30 tests in 5 files. pnpm exec tsc --noEmit, targeted ESLint and pnpm run i18n:compile exited 0. The actual Electron development app from main / 00a6656df plus local changes verified highlighted code, line numbers, explorer toggling and wrapping, real terminal Write-Output/Get-Location, and address-bar navigation with actual web content, title and visibility. Hot-reload interruptions were excluded and affected checks repeated after the source stabilized.

Local evidence: D:/CodeBuddy/.cargo/panel-*-refresh.png, panel-browser-content.png and panel-refresh-acceptance.json; keep it out of Git. No installer rebuild, commit or push in this update. Dark theme support is implemented but was not separately exercised through real interactions.

## 2026-10-26 File actions and document reading

Earlier build identities and acceptance records apply only to their recorded dates. Local file links open in the sidebar; Ctrl/Cmd-click requests an external viewer through the main process. Code files use VS Code's file URI instead of executable OS associations. Markdown, ordinary text and CSV retain the user's default application. Image pixels open a lightbox with a transparent surface, an actual zoom percentage and one fit control. Image, file-link and web-link menus remain distinct. Size observation begins after the dialog node mounts.

PDF, DOCX and PPTX support sidebar reading, text selection and zoom. XLSX uses the upstream read-only grid. Office originals are not edited or saved here. Main-process scope, canonical path, version and bounded-read checks remain authoritative. The official OfficeToPdf service owns conversion, queuing, cache and cancellation; closing or refreshing cancels the relevant request without overwriting the source.

The adapter pins upstream 0.2.1-alpha.2 and fails explicitly on incompatible updates. PDF.js 6.3.289 uses Math.sumPrecise, which Electron 41 lacks; embedded-font parsing can consequently fall back to incorrect glyphs. The adapter installs a standard compatibility implementation in both PDF contexts only when needed, retaining the core-js MIT license in both outputs. Rendering algorithms remain upstream. Do not replace precise summation with ordinary reduce or weaken font security. Remove compatibility only after both contexts support the native API and precision/font/rendering regressions pass.

Run `node --test ui/desktop/scripts/dsh-document-preview-assets.test.mjs` from the repository root, alongside the existing desktop test:run, typecheck and i18n:check commands. Isolated rendering checks do not establish full product acceptance. Restart through the standard preview entry after changing main-process code or Vite adapters; hot reload and successful compilation alone do not confirm the loaded build.
