# Conversation editing, retries, and forks

Source is the current `D:\CodeBuddy-v1` workspace; see [source-baseline.json](source-baseline.json). The renderer is unchanged. No dependencies were installed and no commits or pushes were made. Implementation lives in `runtime/conversation-driver.mjs`, `runtime/conversation-editing.mjs`, and a thin fork adapter in the Harness driver.

The original `chatSessionController.ts` retries ordinary requests by appending the original user request to the current session, without truncation. Editing calls `_goose/unstable/session/conversation/truncate` and then sends edited content. Ordinary forks use `session/fork` with optional `_meta.conversationBefore`; the existing CodePro UI disables forks. Continuation and verification retries remain CodePro control-plane operations.

Pinned official Harness `0.2.1-alpha.2` provides `sessionController.fork({sessionId,atSeq})`, creating a native session from an exact event prefix and closing open turns. Its append-only Session has no in-place truncate API. This implementation uses official forks without modifying JSONL or introducing another model loop. The MIT developer preview remains pinned. [Official repository](https://github.com/deepseek-ai/deepseek-harness)

## Integration contract

```js
const driver = createConversationDriver(rawDriver, store);
const editing = new ConversationEditing(store, driver, {
  isActive: id => active.has(id),
  beforeTruncate: async session => { /* Call the CodePro owner's cancellation API. */ },
  onChanged: id => initialized.delete(id),
});
await editing.request(method, params);
```

- Wrap the driver before server integration. Add `fork` and `history` to lazy dispatch; other driver methods pass through. Prompts must use the original UI `userId` as `requestId`; steering preserves its actual message ID too.
- Fork returns a new product `{sessionId}`; truncate returns `{}`. One product-store commit changes visible messages, usage, and `nativeSessionId` while preserving the product session ID. Old native logs and `conversationEdits` lineage remain. Files are not rolled back.
- The exact boundary precedes the matching user-rpc admission in `agent/inbox/spliced`. Cutting only before `user/message` would retain queued old input. The new native log completes official flush before its product pointer is published.
- The facade maps session arguments, root event/approval identities, and host-tool execution context. Child agents retain their actual IDs. Editing, prompting, and direct tools share an exclusive operation boundary. Memory, MCP testing, and skill refresh remain upstream driver capabilities.
- Active CodePro sessions reject edits. An idle edit uses the existing owner's `runs.control` emergency_stop for nonterminal old runs; completed/cancelled/failed/fatal/exhausted conclusions remain intact. The next prompt starts a new run. Prior effects, uncertain effects, and audit facts remain without automatic replay or rollback.

The existing UI uses whole-second cutoffs, so messages in the same second share a removal boundary. Nonchronological timestamps, old preview histories lacking exact UI/native request correlation, read-only imports, and active operations produce explicit errors. Message text is never used to guess a boundary. Copies inherit selected configuration and messages without copying run state, approval receipts, or journal receipts.

If product-state commit fails after old-run cancellation, the original pointer and visible history remain; an unpublished native fork may remain too. The old run's cancellation is still an actual event. This ordering never exposes new model context under an authoritative old run. Further work follows the displayed state, and audit logs are not automatically deleted.

## Validation

From `runtime`, `node --test tests/conversation-editing.test.mjs`: 6/6 passed, exit 0. Tests use real official Harness, controlled loopback HTTP, and temporary directories. They cover first-message edits without queued replay, exact context, same-second semantics, history/usage, restart, actual root/child tool identities, approvals, operation exclusion, cancellation failure, and state-commit failure.

`node --test tests/conversation-editing-acp.test.mjs`: 1/1 passed, exit 0. Real WebSocket ACP and official Harness submit a plan, start a task, and write an actual file. The original UI truncate RPC cancels the old run; the next prompt creates a new run, plan, and model context. Old events and the file remain. No real user model or profile was used. Original desktop editing interactions need separate acceptance.
