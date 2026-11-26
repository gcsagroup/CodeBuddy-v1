# Windows installer UI

Interactive setup first asks who will use CodeBuddy. “Only for me” defaults to `%LOCALAPPDATA%\Programs\CodeBuddy`. “For all users” requests administrator access through Windows and defaults to `%ProgramFiles%\CodeBuddy`. The location page shows the previous directory for that scope, required space and free space on the selected drive. In-app updates keep the scope and directory of the running installation. Removing a machine-wide installation preserves personal data for all accounts.

Choose who will use CodeBuddy. For all users, approve the Windows elevation prompt, then choose the destination. Click Install on the destination page to start copying files.

The installer uses Inno's native light appearance: white content, a light gray footer, consistent typography, content boundaries and button spacing. Browse matches the path field height. The current operation and component appear directly above the progress bar, without a disclosure link or log panel. The finish page places the CodeBuddy mark on the left and instructions and options on the right.

Per-user uninstall keeps personal data by default. Choose to clear only chat history or to clear all managed personal data. Both choices require confirmation. Clearing chats keeps model settings, projects, diagnostic logs and separately exported copies. Silent uninstall always keeps personal data.

The uninstall page also shows the current operation and component above progress, without a disclosure button or log panel. Summaries follow indexed files actually disappearing; Inno remains responsible for deletion. The product image is loaded before removal. The index is observational only and out-of-root entries are ignored. Run `node --test scripts/uninstall-details.test.cjs` for isolated visible and silent uninstall tests covering real component updates, retained application data and uninstalled project files, with native window screenshots.

Implementation: `scripts/installer/installer-ui.iss`, `codebuddy.iss` and `install-details.iss`. Run `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`. The small isolated installer uses a separate AppId to check layout, details and data retention, and captures its own window through PrintWindow. Real shortcuts and application launch are disabled; the actual installation is untouched.

User-provided reference screenshots inform layout and visual hierarchy while CodeBuddy branding and behavior remain intact. Native style reference: [WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm).

## Loading animation sizing

The initial HTML and React startup screens use a 56px frame and 36px mark; conversation loading uses a 44px frame and 28px mark. Text is 14px with lighter shadows and tighter spacing. Centering, light/dark themes, reduced motion and ready-state transitions are preserved. Sidebar running indicators and installer/session logic are unchanged.

## In-place upgrades and installation scope

The scope selector shows the existing CodeBuddy directory for both current-user and all-users installations. If only an all-users installation is registered, that scope is selected by default. If both exist, current-user remains the default; installations are not migrated or combined automatically. Explicit update arguments take precedence.

The location page reads the selected scope’s 64-bit installation record and compares normalized paths, ignoring case and trailing separators. A directory registered under the other scope produces a message naming the required scope, destination, and steps to return to the selector; uninstalling first is unnecessary. A directory containing an uninstaller without a matching installation record remains protected. Its filename alone does not identify it as CodeBuddy, and users are not instructed to delete the uninstaller.
