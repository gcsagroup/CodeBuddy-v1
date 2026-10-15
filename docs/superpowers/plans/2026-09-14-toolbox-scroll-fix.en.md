# Toolbox toggle scroll-jump repair

2026-09-14

Cause: every refresh entered full-page loading, temporarily removed all tool cards, and reduced the scrollable height. The browser clamped the viewport to the top and recreated expanded advanced groups.

Fix: show loading only for the initial load. Subsequent refreshes keep the list mounted and replace its data. Request sequence checks prevent older responses from overwriting newer tool state. Permission and configuration persistence interfaces are unchanged.

Focused verification: 4 files, 27 tests passed, exit 0. Added regression coverage for card identity and expanded-state preservation across consecutive toggles and for out-of-order responses.

Native desktop acceptance: an isolated Electron profile was exercised with real mouse and keyboard input. Disable/re-enable task delegation mid-list retained the viewport; enabling the checklist inside the expanded advanced group retained its lower-list position and expansion. After Ctrl+R, search confirmed that the enabled state persisted. Disabling it in search results preserved the query. Initial toggle settings were restored and the original user window was unchanged.

Full verification passed: 227 files, 2009 tests passed, 0 failed, 4 skipped. Typecheck, full-source ESLint, changed-file Prettier and production build all exited 0. The build reported third-party use client and large-chunk warnings, without failure. Source hashes were unchanged after testing.

This fix preserves the loaded list; it does not add persistent scroll restoration across deliberate page reloads. The existing installer has not been repackaged.

Evidence: `.cargo/evidence/toolbox-scroll-20260914/` (`source.json`, `native-evidence.json`, `gates.json`).

```text
# cwd: D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/toolbox src/acp/toolbox.test.ts --maxWorkers=1
pnpm exec vitest run --maxWorkers=1
pnpm run typecheck
pnpm exec eslint "src/**/*.{ts,tsx}" --max-warnings 0 --no-warn-ignored
pnpm exec prettier --check src/components/toolbox/ToolboxView.tsx src/components/toolbox/ToolboxView.test.tsx
pnpm exec vite build --config vite.renderer.config.mts --outDir .vite/renderer/toolbox_acceptance
```
