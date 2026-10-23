# Windows installer UI

The location page defaults to `%LOCALAPPDATA%\Programs\CodeBuddy`, normally under the current user's C: directory, instead of recalling a previous installation location such as D:. Users can still enter or browse to another directory. This setting does not migrate existing installations or user data.

The installer uses Inno's native light appearance: white content, a light gray footer, consistent typography, content boundaries and button spacing. Browse matches the path field height. The current operation and component appear directly above the progress bar, without a disclosure link or log panel. The finish page places the CodeBuddy mark on the left and instructions and options on the right.

Desktop and Start menu shortcuts and launch-on-finish choices retain their existing behavior. Uninstallation preserves user data and projects. Details show component summaries; internal dependency paths remain in diagnostic logs.

The uninstall page also shows the current operation and component above progress, without a disclosure button or log panel. Summaries follow indexed files actually disappearing; Inno remains responsible for deletion. The product image is loaded before removal. The index is observational only and out-of-root entries are ignored. Run `node --test scripts/uninstall-details.test.cjs` for isolated visible and silent uninstall tests covering real component updates, retained application data and uninstalled project files, with native window screenshots.

Implementation: `scripts/installer/installer-ui.iss`, `codebuddy.iss` and `install-details.iss`. Run `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`. The small isolated installer uses a separate AppId to check layout, details and data retention, and captures its own window through PrintWindow. Real shortcuts and application launch are disabled; the actual installation is untouched.

User-provided reference screenshots inform layout and visual hierarchy while CodeBuddy branding and behavior remain intact. Native style reference: [WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm).
