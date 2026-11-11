# Asynchronous conversation deletion

Approved on 2026-11-10: the confirmation waits only for admission checks and a small durable deletion record. The UI then closes the dialog and removes the conversation. MCP disposal, linked schedule retirement, failed transcript-journal cleanup and full snapshot pruning continue in the background. Workspace files remain.

Store owns deletion visibility. `session-deletions/<SHA256(sessionId)>.json` contains product/native IDs and acceptance time, without copying transcripts. Reads and subsequent commits suppress deleted sessions, including when an older snapshot write finishes late. Failed acceptance leaves the conversation visible. Active tasks and background processes still reject deletion. Cleanup failures retain records and retry with backoff; startup resumes pending work. Only completed cleanup plus durable snapshot pruning removes a marker. Cleanup errors are logged and do not undo committed logical deletion.

Existing profiles require no state-version migration. Before downgrading to a version unaware of these markers, complete cleanup in the new runtime; otherwise old software may expose old snapshot entries. This does not expand deletion into removal of project directories or all native archives. No cloud service or new dependency is required.

The design adopts durable admission and idempotent recovery principles from [Microsoft asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply) and [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), without copying external code. The existing ACP success response commits logical deletion; resource disposal may still be pending.
