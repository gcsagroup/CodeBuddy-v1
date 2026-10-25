# CodeBuddy

[简体中文](../../README.md) · [繁體中文](GITHUB_OVERVIEW_ZH_TW.md) · English

CodeBuddy is a desktop AI development assistant for project analysis, code changes, commands, Git review, memory, skills and MCP tools. The application version is defined in [ui/desktop/package.json](../../ui/desktop/package.json). See the [desktop UX development notes](../../docs/reconstruction/2026-10-25-desktop-ux-and-history.en.md) for image actions, history loading, scrolling, queued input and validation scope. Build, automated-test and real-product results are separate and do not establish universal workflow or platform acceptance.

## Start from source

Prepare Git, Node.js 24.x, the pnpm version pinned in `ui/package.json`, and existing project dependencies. Building independent native tools also requires the Rust toolchain pinned in `rust-toolchain.toml`, Visual Studio C++ Build Tools, Windows SDK and LLVM/Clang.

From the repository root:

```powershell
.\start-preview.ps1
```

The launcher uses existing dependencies and starts the runtime and Electron. Preview and packaged data default to `~/.CodeBuddy`, with launch logs under `logs/preview` and default workspaces under `workspaces`. Configure your model in Settings. Existing projects keep their locations. See the [storage layout](../../docs/storage-layout.en.md) for overrides and migration.

## Windows package

```powershell
node scripts/build-harness-windows.cjs --installer=inno
```

The installer is `ui/desktop/out/make/inno.windows/x64/CodeBuddy-Setup.exe`. It uses existing Inno Setup 6.7+ and the Simplified Chinese translation; see the [build instructions](../../README.md). The Squirrel compatibility path remains available with `--installer=squirrel`. The default data directory is `~/.CodeBuddy`; older data directories are not imported or overwritten automatically.

The installer shows the current operation and component directly above its progress bar. Internal paths and file-level details remain in diagnostic logs; there is no expandable details panel. See the [installer UI guide](../../docs/windows-installer-ui.en.md).

Prepare `runtime/py` and `runtime/office` using the [Office builder](../../scripts/office-builder/README.md) before first packaging. Preparation downloads dependencies; ordinary packaging copies and verifies existing files. The package includes Node and the required runtime payload. Project-specific development toolchains remain project prerequisites.

Prepare independent MCP tools in `runtime/tools/bin` according to `runtime/tools/provenance.json`. The offline build command is:

```powershell
cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1
```

When replacing an artifact, update and verify its size and SHA256 in the provenance record and `runtime/builtin-artifacts.mjs`. Runtime dependencies are pinned in `runtime/harness/package-lock.json`.

Windows staging copies release `vcruntime140.dll` and its upstream license from the prepared Python payload beside the native tools. Missing payload fails the build; nothing is downloaded or installed. Stage verification compares the DLL with its source so a developer machine's system runtime cannot hide a missing dependency.

`node scripts/build-harness-windows.cjs <stage-directory> --make-only` resumes packaging only when the existing application and stage match the same source. Use `--finalize-only` when NuGet completed but Squirrel finalization stopped; archive identity is checked first. Source changes require a fresh build and stage.

## Use and verification

1. Configure the model endpoint, credentials and model in Settings.
2. Open a task in the default workspace or select a project.
3. Start with a read-only project analysis, then specify the intended changes and acceptance conditions.
4. Check file differences, tool receipts and test exit codes. A model's completion message is not an independent acceptance result.

Skills and external MCP services retain their own configuration and permissions. GitHub account authentication and GitHub MCP activation are separate. Never commit credentials or local chat data.

From `ui/desktop`, run `corepack pnpm run typecheck`, `corepack pnpm run test:run` and `corepack pnpm run lint:check` for desktop checks. Runtime integration tests live under `runtime/tests` and `runtime/harness/test`.

Windows checks do not establish macOS or long production-project acceptance. See [delivery and acceptance records](../../docs/reconstruction) for evidence and remaining work. Historical version names and results remain historical facts. Third-party licenses, copyrights and source records are retained, including `runtime/harness/PROVENANCE.json`.
