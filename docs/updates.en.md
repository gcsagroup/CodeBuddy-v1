# In-app updates

[简体中文](updates.zh-CN.md) · [繁體中文](updates.zh-TW.md)

Manually install an update-enabled build (this delivery targets 1.43.13; 1.43.12 is an internal upgrade fixture only). Version 1.43.9 disabled updates and requires this one-time bootstrap. Connect your own GitHub account with read access to private repository `erjinyi-bool/CodeBuddy-v1`. In general settings, select stable or preview, check, download, then restart to update. Stable excludes prereleases. Save files, finish running tasks and close terminals first. Updates retain the installation location, data directory, chats, settings and workspaces; do not delete user data beforehand.

The Electron main process uses the existing GitHub CLI credential transiently. It never embeds credentials in packages, manifests, logs or renderer state and does not use MCP tokens. Recheck after switching accounts. Downloads can be retried; resume and automatic downgrade are not supported in this first release.

Windows uses Inno EXE packages. Mac updates require a signed `.app` ZIP with the same signing identity; DMG is for first installation. Apple Development is for this internal acceptance only. External distribution needs Developer ID Application signing and notarization. Intel requires a separate x64 build.

Increment the semantic version in `ui/desktop/package.json`. Use tag `codebuddy-<version>` or `codebuddy-<version>-<batch>`. Generate the manifest with the existing Node runtime:

```text
node scripts/create-update-manifest.cjs 1.43.13 codebuddy-update.json win32:x64:CodeBuddy-1.43.13.exe darwin:arm64:CodeBuddy-1.43.13.zip
```

Keep the Release as a draft until all packages and `codebuddy-update.json` are uploaded and remote sizes/SHA-256 hashes verified. Legacy releases without a manifest are skipped. Use a new version for replacement packages. Internal acceptance releases should be prereleases; publish to stable only after acceptance.

Electron owns authentication, selection, download and integrity state. Harness prevents shutdown during admitted requests or tasks and flushes state before exit. The Windows helper waits for process exit, invokes Inno at the original path and checks the installed version. Electron/Squirrel handles Mac signature verification and application replacement. Cached bytes are checked again before installation. Windows failure receipts live under `updates` in Electron user data and are reported on next launch. There is no business-data migration rollback mechanism.

Automated tests and real installed-version upgrade acceptance must be reported separately. Compare chats, preferences and encrypted credentials before and after, and verify the running version and resource provenance.

References: [Electron](https://www.electronjs.org/docs/latest/tutorial/updates), [Inno](https://jrsoftware.org/ishelp/topic_setupcmdline.htm), [Apple ATS](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking). Existing components are reused; no new updater framework was added.

The Windows helper acknowledges startup and installation handoff before the application exits. Earlier internal previews had a helper startup defect and were withdrawn; manually install this build over those versions. Acceptance uses a fixed internal 1.43.12 fixture upgrading to 1.43.13. Mac automatic-upgrade acceptance is deferred at the user’s request; this batch distributes only Windows x64 through the update manifest.

Install GitHub CLI and sign in with a personal account that can read the repository. The Windows helper uses system PowerShell modules to avoid conflicts with inherited PowerShell 7 module paths. It validates the installer before the application exits, and checks it again before installation.
