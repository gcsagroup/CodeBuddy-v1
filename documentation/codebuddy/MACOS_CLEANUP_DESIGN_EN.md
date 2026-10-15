# Mac cleanup and recovery adaptation proposal (approved for staged implementation)

Approved 2026-10-05: after the concrete proposal and approval request, the user instructed continued development for Windows parity. Implementation follows the stated staged gates; this does not mean cleanup mutations have passed acceptance.

[繁體中文](MACOS_CLEANUP_DESIGN_ZH_TW.md) · [简体中文](MACOS_CLEANUP_DESIGN_ZH_CN.md)

## Goal and verified state

2026-10-05, existing main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` plus the pending merge and dirty work. Port Windows exact-target audit, quarantine, restoration, separately confirmed permanent deletion and interruption recovery. Bundle23 is the latest delivery. Its rebuilt backend includes stage 22 internal read-only preparation, with product cleanup mutations still disabled.

Windows workspace_lease.rs renames/deletes through held object handles. workspace_lease_macos.rs currently contains internal read-only cleanup preparation only and shared CleanupAudit is Windows-only. Reuse RootCleanupInline.tsx and acp/rootCleanup.ts. ACP and cleanup registry/journal remain the authority owners; UI consumes structured results. Project creation authority does not imply cleanup authority.

## Native experiment and options

Three deterministic OS experiments passed on arm64/macOS 26.6.2, exit 0, using a fresh synthetic temporary directory with fixtures preserved. Evidence: target/macos-parity-20261005/cleanup22-primitives.json. These are primitive observations, not product acceptance.

| Option | Evidence / limits | Decision |
| --- | --- | --- |
| Path check followed by rename/unlink | Replacing a name after opening it caused renameatx_np to move the replacement despite the held original fd | Reject for exact-object operations |
| Directory fd and RENAME_EXCL | Restore collision returned EEXIST and preserved both contents; operations followed the original parent after a rename | Useful for no-clobber and locating parents, insufficient for source identity or policy paths |
| CoreServices references | Existing empty-directory rollback uses FSRef; Apple marks these APIs deprecated and notes APFS inode compatibility costs | Candidate prototype only; prove identity and race contracts before enabling mutations |
| System trash | Does not provide the application's token, two-confirmation and durable-recovery contract | Not an equivalent replacement |

Use existing system APIs/libc, without new dependencies or copying external implementation source.

## Proposed implementation boundary

1. Reuse the seven root-cleanup methods' business semantics, session/run/sourceMessage/nonce binding and lifecycle barriers. Extract necessary shared types/policy while preserving Windows native operations. Implement Mac internal read-only audit first without announcing full cleanup availability.
2. Keep one explicitly selected regular file or empty directory, conservative temp/cache/build scope, project exclusion, symlink and multiple-hardlink rejection. The object-operation prototype must prove that substitution never touches another object, ancestor changes do not expand authority, and content changes invalidate confirmation. Moving the wrong object and restoring it is not a pass. If proof fails, leave mutations disabled and report evidence; no path-only deletion fallback.
3. First confirmation only moves to a same-volume dedicated quarantine. Restoration encountering an occupied name preserves both objects and reports pending recovery. Permanent deletion requires separate confirmation. Expiry, revocation and restart retain only established recovery/diagnostic paths, not delete authority.
4. Reuse journal phases, integrity checks and owner locks. Mac records use a platform/schema marker and separate namespace with native device/full inode and required reference data. Read existing Windows records unchanged, without automatic migration. Unknown versions/platforms do not modify targets; live delete tokens do not regain authority after restart. Reference persistence details depend on prototype evidence and are not assumed solved.
5. Enable Mac ACP/Agent cleanup only after all object-operation and recovery gates pass; reuse the existing confirmation UI. Any added capability negotiation must preserve older Windows client behavior. Record approved ownership-map revisions, three-language documentation and source manifests before producing a separate installer.

## Required validation

Zero-mutation audit: regular file, empty directory, Unicode/spaces, invalid paths, project overlap, links, read denial. Source/ancestor replacement and rename, restore collision, content/hardlink changes; failures must not touch unrelated objects. Wrong session/run/message, duplicate/concurrent tokens, expiry, close/archive/delete, restart and stale tokens. Inject failures at journal boundaries, tamper with integrity and quarantine directories, retry recovery without restoring deletion authority.

Run scoped Rust tests/fmt/Clippy at each stage and Windows tests for shared contracts. Then test installed backend ACP and the visible desktop audit/cancel/quarantine/restore/separately-confirmed-delete flow, using dedicated synthetic fixtures only. Intel, minimum macOS, TCC/keychain and NOT_RUN remain separate gates. Documentation-only work does not rebuild installers.

## Approval requirement

Root AGENTS.md requires options and migration boundaries before new core abstractions, persistence semantics or authority boundaries. The ownership map explicitly separates creation and cleanup authority. Approval covers this staged adaptation and related three-language/source synchronization. Tests are limited to newly created isolated fixtures; it excludes real user-file cleanup, system permission changes, dependency installation and Git branch/commit/push operations.

## Existing UI/ACP baseline

Ran `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/codepro/RootCleanupInline.test.tsx src/acp/rootCleanup.test.ts` from `ui/desktop`: 9/9 passed, exit 0, using isolated test doubles. Covers existing separate confirmations/cancel/recovery contracts, not real Mac file mutations or desktop actions. Log: `target/macos-parity-20261005/cleanup22-ui-baseline.log`.

## Stage 22: read-only inspection implemented; mutation gate remains open

The existing Windows allowlist, project boundaries and summary structure are shared in `workspace_lease/cleanup_policy.rs`; native Windows handle operations and existing journal semantics remain intact. Mac adds `cleanup_macos.rs` and eight native regressions: held directory/file descriptors, regular-file or empty-directory checks, links, project overlap, path binding, content digest and metadata version. Revalidation reloads authoritative project registration facts. Denied reads return errors without changing target permissions.

This is internal preparation. Mac cleanup RPC/UI, cleanup tokens, quarantine, restore and permanent deletion are not enabled. Remove the scoped dead_code annotation when the mutation gate is satisfied and the module is connected.

Further candidate API evidence: two sequential FSRef scenarios met expectations and 200 concurrent swap trials observed no wrong-object move. These bounded experiments do not establish the required exact-object contract; Apple documents path races in FSRef. F_SETLEASE returned EPERM for the ordinary application context, and XNU requires a private file-leases entitlement. No private entitlement, path-based deletion fallback or move-then-repair strategy is introduced.

The next gate is a distributable object-operation design that satisfies the original contract. Quarantine journaling, restore, separately confirmed deletion and ACP integration follow that gate. The current preparation is neither product cleanup acceptance nor a new installer delivery.

Evidence: `target/macos-parity-20261005/cleanup22-{fsref-candidate,fsref-race,lease-candidate}.json`. Final test status is recorded in `cleanup22-state.json` in that directory.

Validation: Windows related Rust tests 72/72; native Mac Rust tests 22/22, including 8 new cases. Both Clippy checks and Mac fmt exited 0. Mac Clippy reported 7 warnings in unchanged modules. Full desktop cleanup remains NOT_RUN; no new installer was generated.

## References

- [Apple renameatx_np / RENAME_EXCL semantics](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/rename.2)
- [Apple File Manager deprecation and APFS guidance](https://developer.apple.com/documentation/coreservices/carbon_core/file_manager)
- [Apple FSMoveObject object-reference signature](https://developer.apple.com/documentation/coreservices/1566291-fsmoveobject)

- [Apple Secure Coding Guide: FSRef and path races](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html)
- [Apple XNU: allow_setlease and private file-leases entitlement](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/vfs/vfs_subr.c)

## 2026-10-07 approved read-only delivery order (stage28)

The user approved the concrete stage27 proposal. Revise step 5 to expose Mac audit and cancellation first; retain all exact-object mutation and recovery gates.

Reuse audit/cancel routes and capability ownership. Responses and Agent notification data add executionAvailable: false on Mac, true on Windows. Missing values retain legacy Windows behavior; malformed values are rejected. UI shows summaries and cancellation, hiding destructive confirmations and recovery controls. Mac rejects the other five routes, including older-client calls.

Mac receipts retain Inspection and the original capability only in memory. Commit/cancel/revoke share receipt-before-capability locking. Cancellation does not extend the original deadline; expiry and restart do not restore authority. Links, project overlap and changing targets remain rejected with zero target writes. Windows journals and mutation semantics stay unchanged.

Validation includes native temporary files, ACP/component regressions, controlled interaction in a real browser and installed ACP checks. Full Electron acceptance is separate; see MACOS_PARITY_EN.md. Follow existing [ACP extension methods](https://agentclientprotocol.com/protocol/v1/extensibility); fields extend custom response/notification data, not standard ACP types.
