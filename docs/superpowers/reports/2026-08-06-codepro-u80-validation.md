# CodePro U-80 Coordinator Evaluation and Qualification Validation

## Outcome

U-80 is complete at the evaluation and rollout-qualification boundary. CodePro now has a strict 30-scenario Coordinator suite, deterministic scoring, confidence-bound comparison with the legacy path, evidence-bound qualification records, requested-mode capping, and an executable Windows qualification compiler.

No provider/model/reasoning combination is newly marked authoritative by this package. No live v1 Coordinator observation set exists in the repository, so the honest current result is `NOT_MEASURED`; advisory and authoritative requests without exact current evidence are capped to shadow.

## Corrected historical assumption

The existing Ollama Cloud G0/G1 records evaluate basic exact JSON and read-only repository diagnosis. They do not evaluate the U-78 Coordinator schema, authority validation, planning, failure recovery, permissions, evidence provenance, convergence, or adversarial scope escalation. U-80 preserves those records as historical general-agent evidence but never converts them into Coordinator qualification.

## Delivered

- Versioned suite `codepro-coordinator-eval-v1`:
  - exactly 30 scenarios;
  - seven required categories: schema, planning, failure recovery, permission, evidence, convergence, adversarial;
  - at least three repetitions for every ordinary scenario;
  - 180 safety-critical attempts, exceeding the required 100;
  - frozen thresholds that cannot be lowered by editing the fixture.
- Deterministic host-fact scoring:
  - initial and after-one-repair schema rates;
  - expected/forbidden action correctness;
  - evidence validity and false-completion counts;
  - critical violation classes;
  - paired candidate-vs-legacy 95% confidence lower bound;
  - first-token latency, total latency, tokens, and cost, with explicit `not_measured` rather than invented zeroes.
- Maximum evaluated mode:
  - any critical safety violation forces shadow;
  - safe but sub-authoritative results may reach advisory;
  - authoritative requires every frozen gate.
- Qualification registry schema v2:
  - exact provider/model/reasoning/protocol/prompt/evaluator identity;
  - `passed`, `advisory`, and `failed` status;
  - lowercase SHA-256 binding to the evaluation artifact;
  - strict expiry, size, count, duplicate, schema, and unknown-field checks.
- Rollout enforcement:
  - advisory and authoritative now require exact current qualification evidence;
  - requested mode is capped at the record's maximum mode;
  - missing, failed, expired, mismatched, corrupt, or synthetic evidence caps to shadow;
  - authoritative authorization stamps remain unavailable below authoritative.
- Evidence production:
  - strict versioned observation input;
  - live versus synthetic source distinction;
  - synthetic observations are always capped at shadow even if their score is perfect;
  - deterministic evidence and registry output;
  - `create_new`, `flush`, and `sync_all`, with refusal to overwrite prior evidence;
  - Windows wrapper that accepts no credential argument and logs no model content or secrets.

## Fresh verification

- `cargo fmt --all -- --check`: passed.
- 37 `codepro_*` integration targets: 229 passed, 0 failed, 1 ignored. The ignored test is the explicit visible Windows Notepad test.
- Goose library: 2004 passed, 0 failed.
- Qualification compiler binary `cargo check`: passed.
- Qualification compiler end-to-end integration test: passed; synthetic evidence produced files and remained failed/shadow in the registry.
- Desktop TypeScript, ESLint, and i18n gate: passed for 15 locales and 1935 messages.
- Desktop Vitest: 124 files passed; 941 tests passed and 4 skipped.
- Distribution tests: 32 passed, 0 failed.
- `git diff --check`: passed.
- No dependency manifest or lockfile changed.
- All new implementation files remain below 800 lines.

The Rust build reports only the same eight inherited dead-code warnings in `github_auth/credential_store.rs`.

## Qualification status

| Exact combination | U-80 Coordinator evidence | Maximum mode |
|---|---|---|
| All current provider/model/reasoning combinations | `NOT_MEASURED` | `shadow` |

This is not a failed model comparison; it is an absence-of-live-evidence result. Promoting a model based on its name or the older G0/G1 records would violate the design and is intentionally impossible.

## Remaining production boundary

U-80 provides the suite, observation schema, scorer, compiler, registry, and rollout enforcement. It does not fabricate live observations and it does not yet expose qualification state in the desktop. U-81 must surface effective/requested mode and qualification reason through ACP/UI. U-82 must run the frozen suite against real configured candidates in the installed Windows build, archive raw structured observations and metrics, and install only the resulting exact registry records.

## Workspace hygiene

Pre-existing user-owned changes under `documentation/` were neither modified, staged, nor committed.

## Next package

U-81: versioned ACP run projection/events, desktop task/Agent/evidence/audit views, pause/cancel/emergency controls, recovery and uncertain-effect resolution, and visible requested/effective Coordinator mode.

