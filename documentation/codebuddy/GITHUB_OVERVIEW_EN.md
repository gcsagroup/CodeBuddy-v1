# CodeBuddy

## Current Harness candidate (D:\CodeBuddy-v1)

Git contains source, dependency lockfiles and licenses, excluding local model credentials, chats, raw acceptance captures, `node_modules`, build output and installers. `vendor/deepseek-harness` is only a local upstream reference cache; runtime dependencies are pinned in `runtime/harness/package-lock.json`. A fresh clone also requires the platform MCP executables described by `runtime/tools/provenance.json` under `runtime/tools/bin`, in addition to development dependencies. Startup and packaging verify these files; prebuilt tools are not stored in Git. The current Windows installer already bundles these runtime components.

Final Windows candidate `1.43.3-harness7` is installed. Its initial homepage shows the deployed 65536 capacity (about 66k), fixing the old 33k fallback that squeezed output allowance and interrupted replies. Two real installed UI conversations streamed to completion with first text at 8.0/3.9 seconds; conversations appeared in about one second. A cold-start sample still took 45 seconds, so latency is not fully resolved. Intermediate-candidate evidence from this batch covers six compactions, fact retention after restart and file tools. Installer: `target/accepted-harness-installer-1.43.3-harness7/CodeBuddy-Harness-Setup.exe`. Launch CodeBuddy Harness; workspace `~/CodeBuddy-Workspace`, data `~/.CodeBuddy-Harness`; existing settings preserved. See [acceptance record](../../docs/reconstruction/2026-10-15-context-capacity.en.md). macOS and hours-long production projects remain unverified.

The installer includes the existing build-machine Node 24 executable and its license. Harness and its native task runners use bundled Node. The packaging gate executes PowerShell and file search; project-specific language toolchains remain project prerequisites.

Windows installer entry: run `node scripts/build-harness-windows.cjs` with existing Node 24+ and local dependencies. Electron Forge/Squirrel bundles Harness, the adapters and verified MCP tools. The separate install ID is CodeBuddyHarness, with data in `~/.CodeBuddy-Harness`. Configure a model on first launch; old data is not imported automatically. See the [installer acceptance record](../../docs/reconstruction/2026-10-15-harness-package.en.md). With an unchanged packaged application from the same build, `node scripts/build-harness-windows.cjs <stage-directory> --make-only` resumes installer generation. Do not use it to skip rebuilding changed application sources.

Harness owns execution in this directory. On Windows, use the existing launcher:
After NuGet succeeds, `node scripts/build-harness-windows.cjs <stage-directory> --finalize-only` resumes interrupted Squirrel finalization. It first verifies the application archive and Harness manifest against the current package. Existing packaging tools are staged under `target/harness-winstaller-*` with the host-specific 7-Zip aliases; installed dependency directories are unchanged.

```powershell
Set-Location D:\CodeBuddy-v1
.\start-preview.ps1
```

The launcher selects an existing Node.js 24+ runtime, prepares the SDK and language resources, then starts the Harness bridge and Electron. It does not install dependencies. Models, history and settings remain in `.preview-data`; logs and the launch receipt are in `.preview-data/logs/preview`. New tasks get separate working directories under `D:\CodeBuddy-Workspace`, or you can select an existing project. Configure models in Settings.

The start-preview command above is the source development entry with data separate from the installed app. See the [installed acceptance record](../../docs/reconstruction/2026-10-15-harness-package.en.md), [overnight acceptance record](../../docs/reconstruction/overnight-acceptance.en.md) and [feature matrix](../../docs/reconstruction/v1-functionality.en.md) for verified scope and gaps. The original `start-gui` and Rust packaging instructions retained below belong to the legacy backend and do not launch this directory's Harness version.

A Windows desktop AI development assistant for project analysis, code changes, commands, Git review and configurable tools. This is a source development preview; not every workflow has completed real-world acceptance.

## Legacy backend source launch instructions

Install Git, Node.js 24.x (24.10 or compatible), Visual Studio 2022 C++ Build Tools, Windows SDK and LLVM/Clang. Rust is pinned in [rust-toolchain.toml](../../rust-toolchain.toml); pnpm is pinned in [ui/package.json](../../ui/package.json).

```powershell
git clone https://github.com/erjinyi-bool/CodeBuddy.git
Set-Location .\CodeBuddy
corepack pnpm --dir .\ui install --frozen-lockfile
Set-Location .\ui\desktop
node .\scripts\prepare-platform-binaries.js
corepack pnpm run start-gui
```

If Corepack is unavailable, install it with `npm install --global corepack`. The launcher prepares the backend, SDK and language resources. Initial compilation needs time and sufficient disk space.

## First task

1. Configure the model provider, endpoint, API key and available model in Settings.
2. Select a project folder in New task.
3. Ask: “Read this project and explain its entry points and tests. Do not modify files.”
4. Request a small change with explicit test requirements.
5. Inspect tool receipts, diffs and actual test results before accepting completion.

Use version control for status, diffs and review. Check the target repository before write or remote operations. External MCP services need a working connection. Desktop tasks need a specific application and outcome. Enabled does not mean verified.

For startup failures, check compiler and Clang installation. For model errors, check service credentials and tool support. Preserve session data when reporting recovery issues, and remove private information from logs.

[Full guide](../../README.md) · [Contributing](../../CONTRIBUTING.md) · [License](../../LICENSE) · [Third-party notices](THIRD_PARTY_NOTICE.md)

Upstream goose blog posts and event media are no longer copied into this repository. Documentation links point to the upstream website; images still needed by the guides remain in `documentation/static/img/upstream-blog/`. Local build caches such as `target/` are not source files and are regenerated by builds.
