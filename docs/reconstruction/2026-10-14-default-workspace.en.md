# Default workspace and project binding

This change lives in `D:\CodeBuddy-v1`, using the frozen baseline of the original project's current files. This directory is not a Git repository; no branch, commit, or push was created. See `source-baseline.json` for provenance.

The new launcher prepares `D:\CodeBuddy-Workspace` by default. Windows systems without a D drive and macOS/Linux use `Documents/CodeBuddy Workspace` beneath the user's home directory. Development and isolated acceptance can provide an absolute `CODEBUDDY_WORKSPACE_ROOT`. The application checkout is no longer the default task directory.

The current CodePro frontend already has an automatic directory allocation flow. Only the Electron host and launcher change: without an explicit project selection, each new session receives a unique child under the default container. Users can enter a task directly and follow the existing session creation flow. Explicitly selected projects remain unchanged. The default container and session project are separate directories; the model works in the session project.

`runtime/workspaces.mjs` owns workspace leases and project metadata in the new runtime, retaining the existing ACP methods and responses:

- `workspace/lease/acquire` checks real absolute paths, directory state, canonical paths, and ancestor file identities. Missing projects use nonrecursive creation; an existing target is a conflict.
- `consumeLease` checks connection ownership, the five-minute lifetime, single consumption, and session directory identity. `validateSession` rechecks identity at task entry.
- `releaseSession` removes the process-local binding and retains project files. Pending leases released, expired, or disconnected only remove directories still owned by that creation and still empty; no recursive deletion occurs.
- Leases are not persisted. After restart, the original frontend rechecks the workspace and obtains and confirms a fresh lease.
- Project `sources` CRUD and import/export use real Markdown files in the independent data directory. Deleting project metadata retains the workspace and source files. Exports use the original `version: 1`, `type: project` format.

Integration: `new WorkspaceService(store, { projectDirectory })`, then `handles`, `request`, `consumeLease`, `validateSession`, `releaseSession`, `disconnect`, and `close`. `projectDirectory` must address the new profile's project metadata directory; `store.directory/projects` is also supported.

The implementation observes canonical paths and `dev/ino/birthtime` identity and rejects symlink/junction ancestry. It does not retain the old Rust implementation's native directory handles and does not claim an operating-system sandbox or continuous protection against renames. Root-container child creation interactions and native handle hardening require separate acceptance.

Automated command: `node --test runtime/tests/workspaces.test.mjs scripts/default-workspace.test.cjs scripts/start-harness-preview.test.cjs`, using the existing Node.js 24 runtime. All 14 tests passed, with zero failures and exit code 0. Coverage includes real directory creation, the original frontend host inspection/confirmation contract, directory replacement, junctions, cross-connection access, expiry, renewed bindings after restart, project source CRUD/export/import, and default-directory startup. Tests use temporary directories and do not operate the user's current desktop process. Actual desktop and complete CodePro execution acceptance belong to the integration batch; these tests do not establish acceptance of the entire first release.

References: [Node.js filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html), [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup). This reuses the existing ACP contract and Node built-in filesystem capabilities with no new dependency; the old Rust Agent execution core is not involved.
