# CodeBuddy icons

`codebuddy-selected.png` preserves the exact uploaded selection. Built-in imagegen removes its outer pale background for `codebuddy-master.png`, retaining the graphite tile and interlocking white brackets, and produces the monochrome macOS adaptation `codebuddy-template-master.png`. All shipping formats are exported proportionally with the existing Pillow toolchain. Unused concept images have been removed and remain available in Git history; shipping master artwork is retained.

Run `python ui/desktop/scripts/generate-codebuddy-icons.py` from the repository root to export in-app marks, favicon, PNG, Windows ICO, macOS ICNS, Linux SVG wrappers and tray states. `src/images/prepare.sh` delegates to the same script. SVG embeds the PNG artwork; it is not a traced vector. The update state adds a status dot. Commit sources and exports together.

In-app callers use `CodeBuddyMark`; `GooseLogo` and `Goose` remain compatibility entry points. Tray creation and update transitions use `trayIconFileName`. Third-party provider logos and historical documentation illustrations are outside the product icon set.

Windows tray icons use ICO layers at 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixels instead of system downscaling from 1024px PNG. Windows receive explicit taskbar icon properties via `setAppDetails`; the installed AppUserModelID matches Squirrel shortcuts, while preview uses a separate ID. Exports use contain sizing to preserve nonsquare artwork proportions.

Source assets do not update existing installations or old installers. Rebuild and install to update those; Windows shortcut icon caches may refresh later. Validate Windows and macOS shell appearance on their respective platforms.

Windows verification on 2026-10-19: version 1.43.6 was built in `D:\CodeBuddy-v1`, on `main` at `732113504de3601ab087a609ce20827b814db2c2` plus current uncommitted changes. The workspace also contains independent runtime/macOS changes. This icon batch was not committed or pushed.

- `python ui/desktop/scripts/generate-codebuddy-icons.py`, 5 icon/component Vitest tests, TypeScript `--noEmit`, 4 distribution configuration tests and scoped `git diff --check` all exited 0. An earlier full branding suite had 4 passes and 1 failure: a TLS fingerprint assertion already incompatible with HEAD, unrelated to icons. That suite is not recorded as passing.
- `node scripts/build-harness-windows.cjs` using existing Node 24.21.0 exited 0. The installer is `out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`, SHA-256 `baeabdecb6df02a8ea456ae9e6e037e5f04465a27330e9bbb5c1391aa7d78e70`.
- Running this installer locally with `--silent` exited 0. Launching through the installed root executable opened the application; its menu displayed 1.43.6. All 9 icon layers in the packaged executable, installer, installed executable and root launcher matched the source ICO. Six installed icon asset hashes also matched. The Start menu shortcut ID is `com.squirrel.CodeBuddyHarness.CodeBuddy`; the desktop shortcut working directory is `app-1.43.6`.
- The real window title icon, version menu and new shortcut preview in File Explorer were observed; the preview retained its proportions. The desktop tool did not expose the taskbar or tray overflow surface, so their final appearance remains unverified. macOS shell appearance was not tested. Windows icon caches were not cleared.

Local evidence is under repository `.preview-evidence/branding/` and is excluded from commits. The previous 1.43.5 installer is retained there. Existing user settings and history were not intentionally cleared.

Desktop follow-up on the same date: the user's screenshot still showed the old desktop icon. After confirming the shortcut target and EXE icon were correct, the shortcut was backed up and its icon source changed from the fixed-path launcher EXE to installed `app-1.43.6/resources/images/icon.ico`, preserving its launch target and AppUserModelID. The user then confirmed the new desktop icon appeared, supporting a stale icon cache reference as the cause. This was a local shortcut repair; the installer was not changed, and a subsequent installation will recreate the shortcut.

Generation prompts (built-in imagegen):

1. Selected concept D: two bold interlocking angular ribbon brackets with rounded corners, arranged diagonally into a compact chain suggesting collaboration; warm white symbol on a near-black graphite tile, crisp simple geometry, no typography, bird, glow or scenery.
2. macOS template adaptation: preserve the exact outlines, proportions, diagonal orientation and arrangement of the selected two ribbons; remove the tile and background, turn the ribbons black with transparent surrounding space; no redesign, rotation, shadow or texture.
3. Desktop adaptation: remove only the off-white exterior of the selected tile, replace it with transparency, keep the inner symbol and tile proportions, no stretching, rotation or redesign.

References: [Electron taskbar properties](https://www.electronjs.org/docs/latest/api/base-window#winsetappdetailsoptions-windows), [Squirrel shortcut identity](https://www.electronjs.org/docs/latest/api/auto-updater#windows).

[简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)
