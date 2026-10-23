# Mac installation, updates, and uninstall

Open the DMG, drag CodeBuddy to Applications, eject the image, and launch from Applications. To update, quit and replace the app without running cleanup. Data stays in `~/.CodeBuddy` or the existing custom location. Windows installation is unchanged.

The packaged Mac app provides **CodeBuddy → Uninstall CodeBuddy…**:

- **Keep data (recommended)** removes only the current app copy, retaining settings, chats, pets, projects, Keychain data, and privacy grants.
- **Clean app data** removes known application directories, preferences, and the location record. Projects stay by default. A separate unchecked option includes the current root’s `workspaces` and `backend/workspaces` folders.

External projects, unknown files, historical roots, migration backups, and other app copies are retained. Final confirmation lists paths and estimated logical size, which may exceed reclaimed disk space. Deletion starts after the app and runtime exit. Changed directory identities stop execution; symbolic links are not followed.

Cleanup also attempts to remove the dedicated Keychain item `local.codebuddy.credentials.v1 / aes-gcm-master-v1` and reset privacy grants for `local.codebuddy.desktop`. Retained credential stores keep their shared key. Failures and remaining items are recorded in the system temporary directory under `codebuddy-uninstall-*/result.json`; the completion dialog shows the exact path. Dragging the app to Trash does not invoke this cleanup.

This is a native packaged-app menu action, not an Agent/MCP tool. Harness ownership is unchanged. Public distribution still requires appropriate signing and notarization.

Tests: `node --test runtime/tests/macos-uninstall.test.cjs`, plus the desktop Vitest target `src/storage/macosUninstall.test.ts`. Native builds use `node scripts/build-harness-macos.cjs --arch arm64 --node-license <Node LICENSE>` with existing dependencies. Isolated tests mock Keychain/TCC; actual installation and uninstall acceptance must be recorded separately.

References: [Apple](https://support.apple.com/en-ie/102610), [VS Code](https://code.visualstudio.com/docs/setup/uninstall), [Homebrew zap](https://docs.brew.sh/Cask-Cookbook#stanza-zap). The DMG uses Finder, AppKit, and hdiutil without additional installer dependencies.

Mac packaging checks use randomly named temporary Keychain items, verify encryption, decryption, tamper rejection and Unicode, then delete the items. They do not access the user production master key.
