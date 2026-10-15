# Built-in skills directory candidate verification

Bounded result: the three-file fix survives candidate source distribution, restores include_dir macro compilation, and passes a Rust workspace build from clean candidate source. A desktop package/installer build from that clean candidate has not run.

Reviewed changes: 16 test lines added to builtin.rs, 9 tracked-directory check lines added to the Windows workflow, and one newline in .gitkeep. All three match their initial audited hashes. Only an independent temporary index was used; no real-index changes, commits, branches, or pushes.

The archive has 3617 entries. Python 3.12 tarfile UTF-8/data-filter extraction verified every regular file hash. Windows tar.exe failures on some Chinese names remain recorded as tooling/environment failures. Archived builtin.rs compiled against the archived builtins directory with exit 0; 1 test passed, 0 failed, 0 ignored. The missing-directory HEAD control produced the expected macro error. Existing compiled include_dir dependencies were reused; target was not copied.

HEAD: `e7856bc14aa99e11d52acc88d109a67e2590fdbe`

Candidate tree: `bef4f38ad95bd042be1d74d032af9e903fc88c9a`

Real index before/after SHA-256: `D02F76FCFA339DC8C6D9EF2EB1EEE270EF35F0EFEC93189121FAAEBDCB70BB51`

Evidence: `.cargo/evidence/audit-fixes-20260914/clean-windows-candidate-summary.json`, `clean-builtins-candidate-20260915-final/candidate.patch`, `archive-utf8-manifest.json`, `macro-result.json`.

`cargo build --workspace --jobs 1` ran in `clean-builtins-candidate-20260915-final/source-utf8`, exited 0, and took 45m 54s. `GIT_CEILING_DIRECTORIES` isolated the candidate from its dirty parent repository. The build reused dependency artifacts in `D:/CodeBuddy/target`, so this proves a complete Rust workspace build from clean source rather than a from-empty-target build. Evidence: `clean-workspace-build.log` and `clean-workspace-build.json`.

Clean Rust workspace build: **PASS**. Clean desktop/package build: **NOT_RUN**. GitHub updated: **false**.
