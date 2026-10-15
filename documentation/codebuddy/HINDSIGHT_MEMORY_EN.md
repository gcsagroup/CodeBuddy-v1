# Optional Hindsight memory index

Local Project Memory owns content, provenance, review, expiry and deletion. Hindsight supplies semantic candidates. Runtime desktop state, permissions, task progress and completion receipts remain host-owned.

## Configuration

Disabled by default. Set `CODEPRO_HINDSIGHT_URL=http://127.0.0.1:18988` in the backend environment or local configuration and restart the backend. This version accepts only loopback HTTP base URLs without credentials, query strings or subpaths. There is no dedicated settings switch yet. Remove the setting to disable integration.

Enable `create_bank`, `list_documents`, `delete_document`, `sync_retain` and `recall` in Hindsight. The host creates its computed bank through the root MCP endpoint, then scopes all operations to that bank. Canonical project and local memory profile identities determine the bank; the model does not select it.

Enabling permits indexing active project memories in this local service. If Hindsight uses a cloud extraction model, that provider also receives their content. The integration does not copy model credentials. User-scoped preferences are excluded from project banks.

## Operation

- Writes commit locally first. Project writes, edits, deletions and searches schedule background reconciliation against versioned document IDs.
- Jobs are coalesced per project. Failures retry after 30 seconds. Shutdown ends jobs; a later memory operation reconciles again.
- Search keeps local text matches and adds semantic candidates. Network queries have a 1.5-second budget; failure re-reads local data and reports degraded retrieval.
- Every external hit must match a currently valid local record and revision fingerprint. Returned content comes from local storage. Deleted, expired, superseded or invalidated evidence cannot be revived by old index hits.
- Similarity does not prove that a candidate answers a question. Report unknown when evidence is insufficient. Expensive `reflect` calls are not automatic.

## Limits

Candidates can be incomplete while the initial index is pending. Local deletion takes effect immediately during an outage; external copies are removed after service recovery and successful reconciliation. Disabling does not erase external data. Moving a project or changing its profile creates a different bank; explicitly identify old banks before cleanup.

This enhancement affects explicit memory search. Existing bounded local startup context injection is unchanged. Deferred tool definitions are a presentation choice; execution uses the current read-only catalog and preserves explicit host denials.

## Verification

Use the established toolchain in the modified worktree: `cargo test -p goose --lib project_memory --jobs 1 -- --test-threads=1` and `cargo test -p goose --lib read_only_analysis --jobs 1 -- --test-threads=1`.

The live test is ignored by default. After authorizing local model costs and synthetic data, run `cargo test -p goose --lib hindsight_live_roundtrip_update_delete_and_isolation --jobs 1 -- --ignored --test-threads=1` against `127.0.0.1:18988`.

On 2026-09-30, real product acceptance with this rebuilt backend and Kimi passed saving, new-conversation paraphrases, unknown-fact follow-ups and Hindsight offline fallback. Final host states were finished; local records, actual tool receipts and visible answers were checked. Separate real-service regression covered updates, stale revision rejection, isolation and deletion synchronization.

Scope: a small synthetic sample, not all models. Natural-language forget/clear has not passed full conversational acceptance. Retrieval calls took about 40–195 ms; offline fallback about 1.55 seconds. Full tasks also include model waiting and completion checks; this run had a model wait over two minutes and two temporarily unavailable preflight attempts.

Reference: [official Hindsight MCP documentation](https://hindsight.vectorize.io/developer/mcp-server).

## Related fixes

Read-only follow-up authorization uses the current tool catalog; deferred definitions no longer imply revoked tools, and explicit host denials remain binding. Memory tasks keep their eight-turn cap but reserve one final-answer turn, rather than inheriting a five-turn development reserve that removed tools on turn four. Contract inspection and malformed-request receipts include argument-shape examples. The model still selects real sources and receipts; the host does not invent evidence or accept malformed fields.

Memory-only work uses the existing ToolAction task kind rather than the SimpleChange workspace-delta gate. Completion still validates the current requirement revision, specific memory target and memory-owner receipt. That receipt cannot prove delivery of another memory or a workspace file.
