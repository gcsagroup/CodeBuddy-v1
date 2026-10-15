# CodeBuddy branding and compatibility

## Scope

Source: main at c3a537517a464053d090bc1983bafeddd00a79df plus this uncommitted patch. Rename product text, window/menu/tray labels, model identity prompts, 15 locale catalogs, package and installer identifiers, environment variables, launch/acceptance scripts, source identifiers, filenames, documentation directories and GitHub links. Keep upstream goose, the CodePro workspace mode and third-party project names. Preserve the existing Windows PTY packaging fix.

## Approved compatibility

- Fresh installations use `.CodeBuddy`. If it does not exist and `.CodeAgentPro` exists, reuse the existing directory. Explicit new HOME overrides win. Do not copy, relocate or delete existing data.
- Accept old `CODEAGENTPRO_` launch variables as aliases; explicit `CODEBUDDY_` values win, including empty values subject to existing validation.
- Keep credential namespaces, the persisted revision field, historical evidence fingerprints and pending-cleanup quarantine naming stable. These identifiers are compatibility formats rather than visible branding.
- Read existing hint files, migration manifests, old product deep links and ACP metadata. New UI and emitted product links use CodeBuddy. Preserve existing custom-model selections and endpoints; the project's existing configuration normalization still runs.
- Windows installer identity becomes `CodeBuddy-Setup.exe`; macOS becomes `CodeBuddy.app`, with bundle ID `local.codebuddy.desktop`. A new macOS bundle ID requires system permission confirmation. Existing installed apps and previously generated packages are not modified in place.

## Acceptance and delivery

Commit status in this document describes the state when acceptance finished. Subsequent commits and pushes are recorded in Git history.

Local evidence: `target/brand-*.log` and `target/brand-*.exit`. The rename manifest and before-change backup are `target/brand-rename-manifest.json` and `target/brand-rename-backup.zip`; none are committed. This patch is not committed or pushed. Earlier installer files do not represent this source.

### Executed checks

Commands ran in the checkout containing this patch. Frontend commands use `ui/desktop`; Rust commands use the repository root.

| Check | Actual result | Evidence |
| --- | --- | --- |
| `pnpm run typecheck` | Final source rerun: exit 0 | `brand-typecheck-final.log` |
| `pnpm run i18n:compile` / `pnpm run i18n:check` | Exit 0; 15 locales and 2728 message IDs validated | `brand-i18n.log` / `brand-i18n-check.log` |
| `pnpm run test:distribution` | Final 51/51 passed, exit 0 | `brand-distribution-final.log` |
| Vitest, limited to 9 relevant storage, link, credential-startup, icon and loading-component files | 87 passed, 4 skipped, exit 0 | `brand-vitest.log` |
| Task continuation and cleanup recovery, limited to 3 relevant files | 28/28 passed, exit 0; 2 files rerun after stabilizing wire IDs, 21/21 passed | `brand-acp-vitest.log` / `brand-acp-wire-final.log` |
| `pnpm run test:macos-package` | Packaging logic executed on Windows: 15/15 passed, exit 0; not native Mac acceptance | `brand-mac-package-tests.log` |
| `pnpm run build-goose-sdk` | Exit 0 | `brand-sdk.log` |
| `cargo fmt --all -- --check` | Final exit 0 | `brand-format-final.log` |
| `cargo test -p goose --test codebuddy_storage_paths --jobs 1 --locked --offline` | Final source: 5/5 passed, exit 0 | `brand-rust-final.log` |
| Source, filename and Word integrity audit | All 117 renamed targets exist; no old filenames remain; three report DOCX files have valid ZIP contents and no old brand in XML | `brand-source-audit.json` |

The initial distribution run found an outdated locally generated Windows shim. Synchronizing it from tracked source fixed the rerun. Existing caches were retained; an isolated regression validates reuse, precedence of a new cache and no download. The initial formatting failure was also corrected and rerun. Failure logs remain available; authoritative results are the evidence listed in this table and the desktop acceptance section.

A development backend build triggered full compilation under another build configuration and was intentionally interrupted, exit 1. It is not a passing gate. The first direct CLI build exited 101 because the shell lacked LLVM discovery configuration. Initializing the Windows SDK through the existing `resolveWindowsBuildEnvironment()` then running `cargo build -p goose-cli --bin goose --jobs 1 --locked --offline` with the same default debug profile succeeded, exit 0; see `brand-cli-build-final.log`. The new binary's `goose.exe --version` returned `1.43.0`, exit 0. This is the upstream backend version; the desktop package remains version `1.43.2`.

### Native Windows desktop acceptance

`node target/brand-native-smoke.cjs` launched the current source and newly compiled backend through the project's official `pnpm run start-gui`, exit 0. Evidence: `target/brand-native-smoke-accepted.log`, `target/brand-native-7JRhw5/result.json` and `desktop.png` in the same directory.

The isolated fixture created only the legacy `.CodeAgentPro` directory and used legacy startup variables. The actual window title and interface showed CodeBuddy. The application reused the legacy directory, retained its data marker, model selection and endpoint, and did not create the new data directory. File read/save through the actual Electron workspace interface passed. Existing provider normalization changed field layout while retaining configuration values. The first two harness attempts ended because stdin was closed and because an assertion expected the old YAML field layout; both harness issues were corrected before the successful rerun.

Scope: no model task or WeChat send was run. Native Mac acceptance has not been rerun, and new Windows/Mac installers have not been generated. These source changes have not been committed or pushed.

### Compatibility format details

Existing ACP field names remain the stable emitted wire format; readers also accept the new namespace. This avoids breaking continuation between a new frontend and an existing backend. Remaining old names occur only in compatibility fields, data directories, credentials, historical fingerprints and associated tests or explanations. Reading old deep links does not imply registering the old OS protocol for a new installation. Existing portable Windows Node caches are reused only when the version marker matches.
