# Bounded history pagination and search acceptance

No product logic changed. Three component regression tests were added; the related three files passed all 23 tests. TypeScript, ESLint and Prettier exited 0. The existing backend history result remains 11 passing tests; Rust was not rebuilt.

An isolated Electron profile and real ACP used 105 fixture rows. Native screenshots individually covered all 105 rows and the 50/50/5 boundaries. Keyword changes returned 50 Beta and 55 Alpha rows; clearing restored visibly nonmatching original records. B-105 and A-055 opened with their expected bodies through global history. Refreshing still returned 55 Alpha rows. All eight preexisting isolated session rows retained their hashes. The owned window closed and its launcher exited 0.

Native keyword changes did not force delayed transport. Deferred-promise component tests establish stale page, keyword and workspace-mode response isolation. The UIA text cache stayed stale while scrolling, so actual screenshots establish pagination. History is global; workspaceMode filters session type, not project paths. Project/date filters and archive/batch management remain for later audit. Real model execution is NOT_RUN; neither 120 nor 107 was probed.

Evidence: `D:/CodeBuddy/.cargo/evidence/audit-fixes-20260914/history-pagination-native-summary.json`, `history-pagination-native-scan.json`, `history-pagination-focused.log`, `history-existing-preserved.json`.

Command (cwd `D:/CodeBuddy/ui/desktop`):

```text
pnpm exec vitest run src/components/sessions/SessionListView.search.test.tsx src/components/sessions/SessionListView.capabilities.test.tsx src/acp/__tests__/sessions.test.ts --maxWorkers=1
```
