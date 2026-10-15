# Capability discovery, extension approval and Mac permission diagnosis — 2026-10-13

[简体中文](CAPABILITY_PERMISSIONS_20261013_ZH_CN.md) · [繁體中文](CAPABILITY_PERMISSIONS_20261013_ZH_TW.md)

## Evidence and changes

Mac conversations `20261013_1` and `20261013_2` came from `c3a537517a464053d090bc1983bafeddd00a79df + dirty`. The first inferred missing desktop capabilities from `list_functions`, a filtered read-only callback catalog that intentionally excludes computer control. The final extension snapshot does not establish the initial toggle state. Subsequent actual `qwen_computer__list_apps` calls in both conversations returned screen-recording permission errors, proving that the extension was loaded at those points.

Read-only SSH inspection found two running applications: `/Volumes/CodeBuddy/CodeBuddy.app` identifies as `local.codebuddy.desktop`; the older `~/Applications/CodeAgentPro-Test-20261001-4nejwg57/CodeAgentPro.app` identifies as `local.codeagentpro.desktop`. The screenshot grants access to the older application; that is not evidence of a grant to the new process. The Swift helper only preflighted permissions without requesting authorization, and its error omitted the actual application identity and path.

- `platform_extensions/code_execution.rs`: retain read-only callback definitions and append ExtensionManager's actual inventory. Inventory is not execution permission; computer tools remain direct tools, not TypeScript callbacks.
- `platform_extensions/ext_manager.rs`: discover capabilities before proposing activation; wait for host approval and distinguish loaded extensions from OS permissions.
- `permission/permission_inspector.rs`: extension activation uses the existing approval flow, including autonomous mode; existing explicit allow/deny and scoped consent remain effective. No new ACP or persistent permission format.
- `extension_manager.rs`: regression coverage for discovering direct computer tools and invalidation after removal.
- `tools/qwen-computer-use/macos/{RuntimeContract.swift,runtime.swift,contract-tests.swift}`: no prompt when granted; request missing access and recheck OS state. Errors identify the actual name, bundle ID and path. doctor remains read-only.
- `ui/desktop/forge.config.ts`: screen-capture and accessibility usage descriptions.

ExtensionManager, PermissionInspector and the native helper retain ownership of loaded capabilities, activation approval and OS permission facts respectively. No natural-language authorization inference and no TCC database access. Showing a prompt does not establish a grant.

## Validation and delivery

- `cargo test -p goose --lib permission::permission_inspector::tests --jobs 1`: 53 passed, exit 0, including activation-consent regression coverage.
- `cargo test -p goose --lib --features code-mode capability_activation_catalog --jobs 1`: 1 passed, exit 0; the first attempt failed to compile a new test method reference (exit 101), corrected before the passing rerun.
- `node --test ui/desktop/scripts/macos-package.test.cjs`: 15 passed, exit 0.
- Mac native contract tests and the complete helper compiled with `xcrun swiftc -parse-as-library -O -target arm64-apple-macos14.0`; tests and both compilations exited 0. Checks cover existing grants without prompting, denial remaining denied, post-request rechecking and application identity resolution. The complete helper retains one existing API deprecation warning.

- `cargo test -p goose --lib --features code-mode agents::platform_extensions::code_execution::tests --jobs 1`: 12 passed, exit 0.
- `cargo fmt --all -- --check`, `git diff --check`: exit 0.

- Logs and input hashes: `target/capability-permissions-20261013/`, local evidence excluded from source commits.

Local source: `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce` plus previous and current uncommitted changes. Native checks compile hash-matched local inputs in a separate remote build directory; the remote checkout at a different revision and installed applications remain untouched.

Actual system prompts, the full approve/deny desktop flow and WeChat message delivery have not been accepted. No messages sent, applications switched, system permissions changed, installer produced, commit or push. Automated checks do not update installed applications. Existing explicit Always Allow rules are reused; models must still propose activation, and inventory does not execute or authorize anything. Run the current app from a stable installation location before granting access through the system prompt.

References: [Apple screen-recording permissions](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac), [system request API](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess%28%29).

## Subsequent Mac installation update (2026-10-13)

This updates the earlier source-fix stage where installation was not yet performed.

- Built version 1.43.2 / arm64, delivered to remote Desktop/CodeBuddy-Mac-20261013-permissions and launched normally from /Applications/CodeBuddy.app. Existing applications, configuration and history were retained.
- Local source: main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty. Remote Git base remains c3a537517a464053d090bc1983bafeddd00a79df + dirty. Backed up and synchronized 35 differing files, then verified 2,054 build inputs match. Embedded revision reports the remote base; source-applied.json and delivery.json document the content mapping.
- Release backend, bundle and installation smoke exited 0. Mac packaging tests: 15 passed; extension component tests: 16 passed. Installation smoke covered DMG/signature integrity, installed-copy startup, file read/write/search, real PTY and WebContentsView.
- Real session 20261013_3 used existing Ollama / deepseek-v4-pro:0813. Missing screen recording permission triggered a real CodeBuddy system prompt with the correct application identity in the tool receipt. After user authorization and restart, list_apps returned six windows without another prompt. No external messages sent.
- **Overall PARTIAL**: successful tool output was followed by repeated completion checks and persisted paused / completion_blocked with interrupted terminal status. Permission and window enumeration passed; full-turn completion did not. Model self-report is not host completion evidence.
- Not exercised: disabled-extension approval cards, accessibility input authorization, complete Gemma/MCP regression, Intel or Developer ID notarization. This is an ad-hoc internal test package.
- Initial build using the older default target cache hit xet-runtime E0463. Reusing the already-successful same-day script/target resolved the build without cache cleanup, dependency installation or toolchain changes. The delivery helper was adjusted to streaming hashing for the older Mac Python and reran with exit 0.
- No additional product source changes, commit or push this turn. Package, translated notes and receipts: target/mac-update-permissions-20261013/delivery/.

### Commands and artifact identity

All final commands exited 0 in the established remote build environment:

```text
cargo build --release -p goose-cli --bin goose --target aarch64-apple-darwin --jobs 1 --locked --offline
node ui/desktop/scripts/bundle-macos.cjs --arch arm64 --backend /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/macos-release-20261013/rust-build/aarch64-apple-darwin/release/goose
node ui/desktop/scripts/macos-install-smoke.cjs
node --test ui/desktop/scripts/macos-package.test.cjs
# cwd: ui/desktop
pnpm run test:run src/components/settings/extensions/modal/ExtensionModal.test.tsx
```

DMG SHA256: `ec96e52d8da95f9f9f444885d8347c3978041c84c8529636197361bfcd789b9e`.
Backend SHA256: `5cc9995191d8aae5d610a3b4813188e28ba3f6a3550ca1021786e67c7c930a7c`.
Remote installation evidence: `ui/desktop/out/macos-install-LxevkV/result.json`.
Build logs: `target/mac-update-permissions-20261013/{backend,bundle,install}.log`.
