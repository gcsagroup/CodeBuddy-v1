# Windows child-process initialization and error dialogs

2026-11-10. `0xc0000142` from `python.exe` or `where.exe` means `STATUS_DLL_INIT_FAILED`. It does not establish a missing Python installation, a model defect, or a damaged installer.

The pinned Harness ACL sandbox documents that restricted children need an inherited console. This change retains the native executor and permission boundary. Host startup preserves existing process error-mode flags while disabling blocking critical-error dialogs. The ACL runner preloads a Node module before lowering the token: it initializes a missing console using the native Job launcher's hidden startup attributes and restores redirected standard handles. Existing consoles are untouched. Initialization failure fails closed, without unrestricted retries.

Actual exit status and stderr remain available; the UI shows command failure. There are no registry, global WER, ACL grant, restricting-SID, or default-permission changes. macOS does not call Win32 APIs. Files: `runtime/harness/windows-process-errors.mjs`, `windows-sandbox-startup.mjs`, `windows-sandbox.mjs`, and `index.mjs`.

Validation: 4 Windows process/permission integration tests and 54 related Harness tests passed; 54 related tests passed on Mac. Coverage includes a consoleless desktop carrier, hidden console, PowerShell 7/5.1, nested Python processes, and an EXE genuinely importing a DLL that rejects process initialization. It returns `0xc0000142` without blocking on a dialog; a subsequent command succeeds. Writes outside the workspace remain denied. Source-desktop acceptance used a deterministic local model fixture issuing real commands and confirmed the failed row plus subsequent successful execution. This is not an autonomous-model quality evaluation.

```text
node --test runtime/tests/windows-process-startup.test.mjs runtime/tests/windows-workspace-label.test.mjs runtime/tests/pwsh-failure-audit.test.mjs
node --test runtime/harness/test/driver.test.mjs runtime/harness/test/capabilities.test.mjs
```

Requires existing Node 24, MSVC and Python; `CB_STARTUP_TEST_PYTHON` selects an installed interpreter. No automatic dependency installation. Evidence is under `.local/windows-startup-20261110` and the temporary directory printed by the test. The coworker's original machine still needs a new-package retest. Damaged DLL dependencies, security software, and external programs resetting their own error mode remain possible independent causes.

References: [Microsoft SetErrorMode](https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-seterrormode), [Harness user reproduction](https://github.com/deepseek-ai/deepseek-harness/discussions/8142). The upstream report is a diagnostic lead, not proof of this coworker's root cause.
