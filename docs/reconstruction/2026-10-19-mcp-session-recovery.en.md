# Remote MCP session recovery

## Behavior and boundaries

Fix sessionful Streamable HTTP connections retaining an expired Mcp-Session-Id, including reuse after disabling/enabling or deleting/re-adding identical configuration. The existing MCP bridge, SDK and Harness leases still own connection lifecycle and execution. No scheduler or persistence format was added.

- HTTP 404 on an established session triggers the existing reconnect backoff. A compatibility path accepts HTTP 400 only with JSON-RPC error.code -32600 and exact error.message Session not found. Generic HTTP 400, authentication failures and tool output do not indicate expiration.
- A fresh transport initializes without a saved Mcp-Session-Id header, regardless of its casing. Authentication headers remain intact. Tools are rediscovered; connection status is error during recovery and ready afterward.
- Original requests retain their actual errors. Recovery never replays tool calls, resource requests or accepted Tasks. An operation with an uncertain outcome is not repeated; subsequent independent calls use the new connection.
- Global extension mutations and per-chat extension changes retire matching shared presets. Subsequent acquisition opens a fresh connection. Existing leases continue serving their holders without interrupting other chats; Harness collects them on release. Ordinary discovery and unrelated configurations retain healthy reuse.
- Existing retry budgets, backoff and shutdown cleanup remain effective. Healthy session IDs are not rotated periodically, and stateless protocol migration is outside this fix.

## References

[MCP 2025-11-25 session management](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx#session-management) requires reinitialization without the old ID after a session-related HTTP 404. Reuses installed MCP Client SDK 2.2.0 and DeepSeek Harness 0.2.1-alpha.2 (MIT); no dependencies added. HTTP 400 compatibility interprets the observed server protocol receipt, never model prose.

## Validation

Source: D:\\CodeBuddy-v1, main, base 7321135 plus current working-tree changes. Unrelated existing changes were preserved. Existing Node 24.19.0 ran the related regression selection: 74 passed, exit 0, including a real 65-second synchronous call and asynchronous Tasks. The complete command is recorded in the corresponding zh-CN document.

After adding three boundary cases for accepted-task session loss, retry exhaustion and shutdown cancellation, reran the affected targets:

```powershell
node --test runtime/harness/test/mcp-session-recovery.test.mjs runtime/tests/mcp-session-recovery-acp.test.mjs
```

10 passed, exit 0. ACP coverage uses real WebSocket requests through the current compatibility service and Harness, including settings toggles, delete/re-add, per-chat selection changes and automatic recovery. All endpoints and data directories are isolated local fixtures.

## Real desktop acceptance (2026-10-19, three core scenarios passed)

Launched the current working-tree Electron app through the existing `startPreview` in `scripts/start-harness-preview.cjs`, using an isolated profile, local MCP server and deterministic model fixture. Runtime port: 62957; renderer: localhost:5174; chat: bf402e8a-b86b-4ad8-92a8-20833439ccf3. All six core fix files retain their pre-launch SHA-256 hashes. Desktop message entry and toolbox interactions were checked against visible results, server requests and persisted Harness tool receipts:

- Baseline: 08:44:27 UTC, session-2, execution=1, successful.
- HTTP 404 recovery: old session rejected at 08:48:58.437; initialization without the old ID issued session-3 after 534 ms. A subsequent user message succeeded at 08:49:20, execution=2. The failed invocation was not replayed.
- Disable/re-enable: the UI showed disabled then enabled; session-4 initialized at 08:52:12 and the actual tool succeeded at 08:52:15, execution=3.
- Delete/re-add with the same name and address: desktop confirmation removed the entry from the list (4 to 3 entries) and persisted configuration. Recreated DesktopProbe and its original endpoint through the form, then returned to the original chat. Initialization without an old ID issued session-5 at 09:15:49.251; the real tool succeeded at 09:15:51.280, execution=4.

The previous attempt encountered desktop-helper snapshot and element-cache errors. Resetting node_repl, importing sky again and binding the existing window ID restored control in this run. Some accessibility click positions disagreed with the visible UI; fresh screenshot targeting and observation after each action completed deletion, re-addition and message submission. The development page reloaded during entry; reopening the form allowed completion. No helper or product source was changed, so this verifies recovery of this run, not a permanent repair of the underlying helper issue.

The fixture's `search_mcp_tools` was declined by the existing chat extension permissions. Direct health calls have independent server and persisted success receipts; tool discovery is not marked passed. HTTP 400 compatibility has automated coverage only. Ignored local evidence under `.preview-evidence/mcp-session-desktop/` includes wire.jsonl, source-identity.json, eight screenshots and profile session records. New screenshots: 06-deleted.png, 07-readded.png, 08-delete-readd-success.png. Turn 5 tool/result seq=93 has isError=false and matches the server and UI session-5/execution=4 receipt. The original failed invocation was not replayed. Completion time: 17:15:51 Asia/Shanghai.

Existing Node runs that directory's run.mjs; the launcher remains running with no final exit code. Hash, persistence and three-language document checks exited 0 in this run; previously passing automated tests were not repeated. Updated all three reports; no commit, push or installer rebuild. Real Hex and installed-app acceptance remain untested.
