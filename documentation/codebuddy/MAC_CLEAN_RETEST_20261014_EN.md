# Mac cleanup, reinstall, and computer-control retest (2026-10-14)

After clarification covering source, documents, backups, and keychain entries, the user explicitly requested removal of all CodeBuddy and legacy CodeAgentPro material on the remote Mac before reinstalling. Target: `erjinyi@192.168.9.106`, macOS 27.0.1 / arm64. The Windows checkout, other Mac apps/projects, shared directories, unified system logs, and system backups were retained.

## Completed

- Removed 42 explicitly reviewed paths, covering 29 user installation copies, app configuration/cache/conversations/logs, default test workspaces, desktop/Trash packages, acceptance fixtures, and the source/Git/build/backup tree at `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`.
- Stopped owned processes and detached two installer volumes. `tccutil reset All` succeeded for both bundle IDs. Removed app preferences, the recent Dock entry, and LaunchServices registrations. A subsequent pass removed 31 residual main/helper registrations, leaving zero.
- Deleted exact keychain service/account pairs: `codeagentpro / secrets`, `CodeBuddy Safe Storage / CodeBuddy Key`, and `CodeAgentPro Safe Storage / CodeAgentPro Key`, all exit 0. Secret values were never read. Fresh launch recreated only CodeBuddy Safe Storage; shared `goose / secrets` and old model credentials are absent.
- Saved the new candidate and receipts on Windows before cleanup. Before reinstall, old indexed existing paths, processes, installer volumes, and both default data roots were absent. Available space increased from about 174 GiB to 261 GiB. This is not a secure-erasure or system-wide trace-erasure claim.
- Installed the verified DMG into `/Applications/CodeBuddy.app`; strict signing verification and four installed/source file hashes matched. Detached the installer and deleted the transferred DMG.
- At 13:08 Asia/Shanghai, main PID `73796` and backend PID `73800` both loaded from the fresh installation. `~/.CodeBuddy/state/electron-app/logs/main.log` records `InitializeNew` and React readiness. The session database contains zero sessions and the UI shows no recent chats. The old data root and remote source tree are absent.

## Source and validation

Windows source: `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`; remote Git base: `c3a537517a464053d090bc1983bafeddd00a79df + dirty`. Before cleanup, normalized hashes matched for 2,054 build inputs. Reused the existing Node 24.10.0 / pnpm 11.9.0 environment and previously delivered release backend; rebuilt the Go/Swift computer runtime and desktop package. No Rust rebuild or dependency installation occurred.

| Check | Result |
| --- | --- |
| `node --test scripts/macos-package.test.cjs` | 15 passed, exit 0 |
| `pnpm run bundle:mac --arch arm64 --backend <existing release/goose>` | Exit 0, including Go/Swift checks, compilation, signing and DMG validation |
| `pnpm run test:macos-install` | Installation smoke passed, exit 0 |
| Cleanup, residual unregister, fresh install | Exit 0 with per-action receipts |
| Fresh application launch and empty data | UI, process, log and database evidence verified |
| Kimi K3 vision, focus/input and permission recovery | Not completed |

The initial SSH build wrapper returned 1 for a trailing CR after all three phases had independently exited 0. The first two cleanup attempts stopped before filesystem deletion because TCC reset requires a registered bundle and some paths were already unregistered. Resetting permissions first and unregistering only current records resolved these orchestration errors. Original failure receipts are retained; they are not product test failures.

Candidate: 1.43.2 / arm64 / ad-hoc, not notarized. DMG SHA256: `6d4f51e36b221da6501f239e731dfef2f5cc7370acc66df19cf5be0f51189c30`; installed goose: `fdabb89890c7a00ac36e04735ea08c29f98b35dd431aac8b3582b1149538af49`; native runtime: `4e2b259f1f0c630ca8e0196c579b020b372b1bfa0c5c87002a561daa0e995187`.

At 13:10, macOS reported `CGSSessionScreenIsLocked=Yes` while RustDesk remained at 13:08. UI input stopped and the user was asked to unlock. Old model credentials were deliberately deleted; Ollama must be configured again inside the app, using `kimi-k3` for real-model acceptance. The user handles OS permission prompts and login passwords.

Resume with live-frame verification, model setup, unique installed-path verification, fresh screen-recording/accessibility grants, read-only observation, isolated fixture input, and permission recovery. No external messages were sent. Computer-control product E2E has not passed. No product source edits, commits, or pushes were made in this task. Local-only evidence and the candidate are in `target/mac-clean-retest-20261014/`.
