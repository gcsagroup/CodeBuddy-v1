# ADR-001: Use GitHub CLI as the local GitHub delivery path

## Status

Accepted for CP-04A MVP

## Date

2026-08-11

## Context

CodeBuddy already contains a GitHub App/device-flow implementation, a direct REST Pull Request client, and separate CI/workflow/artifact clients. The desktop exposes that implementation through a large fixed Pull Request form. The current machine has no `gh` executable, and no GitHub App client ID is configured, so the existing path cannot provide an installable local MVP without product-owned credentials.

The CP-04A objective is narrower: provide a local delivery page that detects `gh`, reports login and current Pull Request/check state, and performs a bounded Pull Request creation only after an explicit preview and remote-write approval. Workflow dispatch, rerun/cancel, artifact download, and the full migration remain CP-04B.

### Existing call graph

| Desktop / ACP entry | Current backend | Shared dependants that must remain |
|---|---|---|
| `GitHubAuthCard` → `acp/githubAuth.ts` → ACP `github_auth.rs` | `GitHubAuthService` → device flow + credential store | Existing settings compatibility until the CLI path is qualified |
| `GitHubPullRequestPanel` → `acp/githubPullRequests.ts` → ACP `github_pull_requests.rs` | `GitHubAuthService` → `pull_requests.rs` direct REST client | Repository parsing and Git preflight helpers are reused by CI/workflow/artifact modules |
| `GitHubCiStatusPanel` → ACP `github_ci.rs` | `ci_status.rs` direct REST client | rerun, cancel, workflow dispatch, and artifacts |

The former `github_auth/gh_cli.rs` was a test-only probe and was not the production module selected by this decision. It stayed isolated until the new `github_cli/{mod,models}.rs` path had independent tests. A final hunk audit then showed its two contracts were duplicated by the new public-module tests, so the untracked probe and only its exact `github_auth/mod.rs` test hunks were removed.

## Decision

1. Add `crates/goose/src/github_cli/{mod,models}.rs` as the production boundary. It invokes one literal executable with an argument vector and authoritative workspace cwd; it never constructs a shell command.
2. Bound every invocation by cancellation/timeout, stdout/stderr byte limits, and secret-safe diagnostics. Model text is passed through stdin or a bounded temporary body file, never interpolated into a shell or exposed in argv when avoidable.
3. Detect authentication with `gh auth status --active --hostname github.com --json hosts`. JSON mode cannot be classified by exit code alone; the returned account state is authoritative.
4. Read the current branch Pull Request with `gh pr view --json number,title,state,url,headRefName,baseRefName,isDraft`. Read required checks with `gh pr checks --required --json name,state,bucket,link,description`; exit `8` means pending checks and is not a command failure.
5. Pull Request creation uses explicit `--head`, `--title`, optional `--base`, and `--body-file -`. `--head` prevents `gh pr create` from implicitly offering a fork or push. CodeBuddy performs any requested push as a separate previewed, confirmed effect; `gh pr create --dry-run` is not treated as side-effect-free because the official manual says it may still push.
6. The desktop replaces the fixed PR form with a delivery status surface: repository/branch, `gh` availability/login, current PR, required checks, preview, recovery action, and an explicit create confirmation. Advanced options do not block the MVP.
7. Existing device-flow/direct REST and advanced CI/workflow/artifact code remains behind the rollback path. CP-04A does not delete shared helpers merely because their filenames mention Pull Requests.
8. Real push and Pull Request creation require a test repository and separate user authorization. Without those, online acceptance is `ENVIRONMENT_UNAVAILABLE`; deterministic local fixtures and the no-side-effect desktop path remain required.

## Alternatives considered

### Continue the GitHub App/device-flow path

Rejected for the local MVP because it requires product-owned OAuth configuration and preserves a second authentication stack. It remains a possible future cloud path.

### Continue direct REST requests with stored tokens

Rejected as the primary path because CodeBuddy would continue owning credential storage, REST pagination/version behavior, and recovery semantics already provided by GitHub CLI. Shared advanced clients remain temporarily for CP-04B migration.

### Use MCP as the only GitHub path

Rejected as the required local path because MCP availability and credentials are optional environment capabilities. MCP can remain an extension, not an MVP prerequisite.

## Consequences

- A missing or unauthenticated CLI becomes an actionable product state, not a generic internal error.
- Exit code and JSON must be evaluated together; notably auth JSON mode and pending check code `8` have command-specific semantics.
- The runner becomes security-sensitive and requires fixture coverage for timeouts, cancellation, output caps, invalid JSON, untrusted text, and secret redaction.
- CP-04A can be tested offline with a fake executable and disposable Git repositories. Online writes remain explicitly user-gated.

## Official sources

- GitHub CLI auth status JSON behavior: https://cli.github.com/manual/gh_auth_status
- Current-branch Pull Request JSON fields: https://cli.github.com/manual/gh_pr_view
- Required-check buckets and pending exit code `8`: https://cli.github.com/manual/gh_pr_checks
- Pull Request creation, `--head`, `--body-file`, and the side-effectful `--dry-run` warning: https://cli.github.com/manual/gh_pr_create
- Generic exit codes, including auth-required code `4`: https://cli.github.com/manual/gh_help_exit-codes
- Token/host/repository environment precedence: https://cli.github.com/manual/gh_help_environment
