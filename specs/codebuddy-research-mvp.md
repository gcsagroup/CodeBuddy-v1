# Spec: CodeBuddy Windows Research MVP

## Status

Source implementation completed on 2026-07-21. Full Windows packaging and live
Ollama Cloud verification remain `NOT_RUN` until the documented local toolchain
and user-owned credential are available.

## Objective

Create a separately branded Windows research distribution named
`CodeBuddy` from the existing Goose desktop application. The first release
must let a user start the desktop app, configure Ollama Cloud without
committing a key, retain local Ollama support,
open a source repository, and run an approval-gated coding task.

This milestone is an R&D build, not the final R1/R2/R3 enterprise release. It
does not claim a hardened Windows sandbox, qualified self-hosted models, signed
updates, or production readiness.

## Users and Main Flow

The initial user is a Windows developer evaluating CodeBuddy on a trusted
test repository.

1. Install or unpack CodeBuddy.
2. Start the desktop app.
3. Configure either Ollama Cloud or local Ollama.
4. Select a trusted test repository.
5. Ask the agent to inspect or change code.
6. Review tool requests and the resulting diff.
7. Run the documented test procedure and record the result.

## Scope

### Included

- Independent `CodeBuddy` product name, executable/package metadata,
  protocol name, window title, and non-Goose placeholder icon.
- The existing bundled Ollama Cloud provider is exposed as the recommended
  cloud option for the CodeBuddy research build.
- User-selected Ollama Cloud model ID; no model is marked qualified without a
  real G0/G1 smoke test.
- Existing local Ollama provider remains available.
- Windows research build script that checks prerequisites and produces an
  unsigned local package or explains the exact missing prerequisite.
- Telemetry disabled by default for the custom distribution.
- Automatic update lookup disabled for the R&D build unless a dedicated
  CodeBuddy release repository is configured.
- Chinese quick-start/use guide.
- Chinese test guide, including offline checks, real-provider smoke tests,
  security checks, expected results, and `NOT_RUN` handling.
- Apache-2.0 attribution and a modification notice.

### Excluded from this milestone

- Production code signing, MSIX/App Installer distribution, or Store release.
- Claims of a hardened Windows command sandbox or network isolation.
- Migration of the previous Python prototype into the Goose core.
- Custom multi-agent scheduler or model router beyond Goose's existing
  recipes/subagents.
- G0-G3 qualification claims without real credentials, models, and repeatable
  evaluation evidence.
- GPU capacity, latency, throughput, or Dense/MoE comparison claims without a
  real GPU environment.

## Tech Stack

- Existing Rust workspace and Goose ACP backend.
- Existing Electron 41, React 19, TypeScript 5.9, Vite, and Electron Forge
  desktop application.
- Existing pnpm workspace and lockfile.
- Declarative provider JSON in
  `crates/goose-providers/src/declarative/definitions/`.
- PowerShell for the Windows research build and verification entry points.

No new dependency may be added merely for branding or configuration.

## Commands

The exact executable path may be supplied by Hermit or the local toolchain.
The build script must fail early with actionable output when a prerequisite is
missing.

```powershell
# From D:\CodeBuddy\goose
git status --short --branch

# Provider tests
cargo test -p goose-providers declarative

# Desktop checks
Push-Location ui\desktop
pnpm run typecheck
pnpm run test:run
pnpm run lint:check
Pop-Location

# Rust quality gates
cargo fmt --check
cargo clippy --all-targets -- -D warnings

# Windows research build
.\scripts\build-codebuddy-windows.ps1
```

## Project Structure

```text
specs/codebuddy-research-mvp.md    Approved product and verification scope
tasks/plan.md                         Ordered implementation plan
tasks/todo.md                         Executable task checklist
crates/goose-providers/...            Existing Ollama Cloud provider definition
ui/desktop/...                        CodeBuddy desktop branding and package
scripts/build-codebuddy-windows.ps1 Windows R&D build entry point
documentation/codebuddy/USAGE_ZH_CN.md           End-user setup and usage
documentation/codebuddy/TESTING_ZH_CN.md         Repeatable test procedure
documentation/codebuddy/THIRD_PARTY_NOTICE.md    Attribution and modification notice
```

## Code Style

Follow the repository `AGENTS.md`. Keep custom-distribution changes isolated,
prefer configuration over Goose core changes, keep booleans non-optional with
safe `false` defaults, and do not add comments that restate code.

Existing declarative-provider shape to preserve:

```json
{
  "name": "ollama_cloud",
  "engine": "openai",
  "display_name": "Ollama Cloud",
  "api_key_env": "OLLAMA_CLOUD_API_KEY",
  "base_url": "https://ollama.com/v1/chat/completions",
  "dynamic_models": true,
  "models": [],
  "supports_streaming": true,
  "requires_auth": true
}
```

The final provider definition must conform to the repository schema and tests;
the example is not proof that the live service supports every declared
capability.

## Testing Strategy

### Small/offline

- Existing declarative-provider validation tests cover the bundled JSON.
- New branding/build-script behavior receives focused tests before
  implementation where executable behavior changes.
- Static checks verify no upstream Goose product identifiers remain in the
  CodeBuddy package metadata that users see.
- Secret scans verify no API key or credential is present in tracked files.

### Medium/local

- Desktop TypeScript tests and type checking.
- Rust provider tests and compilation.
- Windows build-script prerequisite, failure-message, and output-path checks.
- Launch packaged app and verify process start, window title, provider screen,
  local session creation, and shutdown.

### Large/real service

- With explicit user-provided credentials, list or configure an Ollama Cloud model,
  run a minimal chat, then run a tool-calling task on a disposable repository.
- Record timestamp, provider/model ID, request/error identifier when available,
  command, exit state, and whether the outcome is `SUCCEEDED`, `DENIED`,
  `BLOCKED`, or `NOT_RUN`.

Live tests must never print or store the API key.

## Boundaries

### Always

- Work on a short-lived Git branch and keep upstream `main` clean.
- Preserve the Apache-2.0 license and clearly identify modifications.
- Use a disposable test repository for write/command tests.
- Run focused tests before full checks.
- Treat model output and tool arguments as untrusted.
- Report skipped external tests as `NOT_RUN`.

### Ask first

- Use or store a real API key.
- Send private repository content to an external model.
- Add dependencies, change updater infrastructure, or configure code signing.
- Push to a remote repository or publish an installer.

### Never

- Commit `.env`, API keys, certificates, signing material, or user data.
- Claim Windows sandboxing, model qualification, R1/R2/R3, or production
  readiness without the required evidence.
- Run autonomous code modification against the user's primary repository for
  the first smoke test.
- Point the rebranded updater at upstream Goose releases.

## Success Criteria

- [x] `CodeBuddy` has distinct user-visible desktop/package branding and no
      user-visible claim of being an official Goose release.
- [x] The bundled Ollama Cloud provider passes the distribution contract and appears
      in the provider configuration UI.
- [x] A user can enter the Ollama Cloud key through the application's existing secret
      mechanism; no key exists in Git-tracked content.
- [x] Local Ollama remains available and existing desktop tests do not regress.
- [x] Desktop type checking, ESLint, i18n compilation, focused tests, and the
      full desktop unit-test suite pass.
- [ ] Rust provider tests, `cargo fmt --check`, and relevant Clippy checks pass.
- [x] The Windows build script either produces a runnable unsigned R&D package
      or stops before mutation with a precise prerequisite report.
- [ ] A packaged-app smoke test verifies start, basic session creation, and
      clean exit; if packaging is blocked, it is not marked complete.
- [x] `documentation/codebuddy/USAGE_ZH_CN.md` enables a new user to configure and run
      the R&D build without reading source code.
- [x] `documentation/codebuddy/TESTING_ZH_CN.md` contains repeatable offline, desktop,
      provider, and safety checks with expected outcomes.
- [x] The final checkpoint lists every real test command and result, plus all
      external conditions recorded as `NOT_RUN`.

## Open Questions and Proposed Defaults

1. Ollama Cloud model: let the user select/enter the model ID; do not hard-code a
   qualification claim. Proposed default: no model prequalified.
2. Distribution: produce an unsigned local R&D package only. Proposed default:
   no public release or updater.
3. Language: Chinese user/test documentation, while retaining upstream source
   language and existing i18n architecture. Proposed default: do not translate
   the entire upstream UI in this milestone.
4. Security: reuse Goose permission prompts but explicitly document that this
   is not a hardened Windows sandbox. Proposed default: test only disposable
   repositories.
