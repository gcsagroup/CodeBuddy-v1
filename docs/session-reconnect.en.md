# UI reconnection and task execution

Refreshing the UI or losing the ACP WebSocket no longer cancels an admitted task. The same Harness execution continues. After reconnecting, the desktop loads the original session, replays its journal and resumes live delivery without resubmitting the prompt or image generation.

`runtime/server.mjs` owns transport and pending RPCs. `runtime/session-connection.mjs` handles client delivery only. `runtime/compat.mjs` attaches replacement clients after session/load replay and projects the authoritative activeRunId. The frontend reloads the current session using existing recovery notifications and clears stale execution displays for finished requests.

Permissions, questions and recipe parameters retain their native request, authorization scope and deadline while awaiting a replacement client. Browser and desktop operations are never automatically replayed. Explicit stop and server shutdown retain native cancellation behavior. Automatic recovery after backend process crashes or system restarts is outside this guarantee. Existing sessions require no migration.

Tool errors retain readable causes. Structured native cancellations no longer become `[object Object]`. Only bounded cancellation kinds and safe transport codes are exposed, excluding arbitrary object fields, stacks and credentials. Native outcomes and retry decisions remain unchanged.

Regression coverage includes continued execution while detached, replay/live delivery, explicit stop, native decision deadlines, no desktop command replay and frontend reload. Real pet-workflow evidence and screenshots are stored locally under `.local/session-reconnect-20261110/` and are excluded from commits.
