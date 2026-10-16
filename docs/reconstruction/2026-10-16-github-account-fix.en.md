# GitHub account settings repair

2026-10-16; `D:\CodeBuddy-v1`, `main`, baseline `04362df`. No installer is produced.

The account card still called retired Rust OAuth ACP methods absent from the Harness runtime, displaying their error alongside the existing CLI connection flow. Remove that obsolete card state machine, unused ACP wrapper and translations; use the existing GitHubConnections/Electron IPC/official GitHub CLI flow. Keep compatibility SDK schemas; do not restore Rust auth or add another OAuth service.

Each account/MCP check stage has a 25-second display deadline and discards late results. Pending MCP checks do not block account login. Consume verified active/state/login from `gh auth status --json hosts`; JSON exit zero alone is not authentication success. Remove the redundant `gh api user` request, share concurrent read-only checks, never cache completed results, and invalidate pre-login/logout queries. These display deadlines do not alter Harness tool execution limits.

Reference: [official CLI documentation](https://cli.github.com/manual/gh_auth_status) and local command help. GitHub CLI owns authorization/credentials. GitHub MCP remains separately configured; no automatic enablement or credential copying.

Validation: 35 auth-settings/CLI Vitest tests passed; final invalidation changes reran 12 CLI tests successfully. TypeScript, changed-file ESLint, i18n extraction/key validation/compilation exited 0. Restarted the current source preview through the README launcher and exercised account settings/refresh; results follow. The existing user account was not signed out. Completing browser authorization for a new account was not exercised; device-flow start/cancel/poll has automated coverage.

Integrate the card, CLI checks, ACP removal and locale changes together, then restart Electron to load its main-process changes. Raw evidence stays in `.preview-evidence/h17-*`; account settings, logs and screenshots are excluded from Git.

Actual desktop result: initial check 3,974 ms; explicit refresh 3,965 ms; account connected, MCP disabled, retired OAuth error absent. One earlier check before removing the duplicate request took 16,249 ms. These are observations under the current network, not a latency guarantee. Evidence: h17-ui-receipt.json / h17-ui-final.png. The restarted source-preview launcher PID is 50132.
