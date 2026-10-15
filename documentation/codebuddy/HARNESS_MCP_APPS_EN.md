# Harness MCP Apps adaptation

Date: 2026-10-14. Source: current files in D:\CodeBuddy-v1. This directory has no Git revision; no commit or push was made. Renderer sources remain unchanged.

## Implementation

- `runtime/harness/mcp-bridge.mjs` owns one connection per MCP server in each session. It reuses the official MCP SDK Client, Harness `createMcpToolDefinition`, and `mcpResources.register`. Harness retains the sole model loop, tool execution and approval pipeline.
- Raw MCP receipts are correlated by execution token. The host restores `content`, `structuredContent`, and `_meta` only for successful final outcomes whose canonical value and presentation remain unchanged. Policy replacements never restore the earlier raw data. Tool `_meta.ui.resourceUri` maps to the existing renderer's `_meta.goose.mcpApp` contract.
- `resources/read` returns `{result: MCP ReadResourceResult}`, preserving text, blobs and resource metadata. Only enabled, connected servers in the current session are admitted. Reads use official resource tools with independent approval, do not enter model history, and support active conversation reads and cancellation.
- `runtime/mcp-apps.mjs` implements the frozen ACP `apps/list/import/export/delete` methods. Local imports use GooseApp JSON-LD and persist in the new profile's `state.mcpApps`. Name conflicts receive numeric suffixes. Remote cached apps are not deleted as local imports. Size, count and pagination limits apply.
- `runtime/mcp-app-proxy.mjs` owns the HTTP sandbox; the trilingual MCP app proxy notes in `docs/reconstruction/` describe origin separation, authentication and TTL.

## Validation and boundaries

`node --test runtime/tests/mcp-apps.test.mjs runtime/tests/mcp-apps-harness-integration.test.mjs runtime/harness/test/mcp-apps.test.mjs runtime/tests/builtin-extensions.test.mjs runtime/harness/test/capabilities.test.mjs`: 30/30 passed, exit 0. After tightening metadata restoration around post-execution policy changes, the affected four driver tests and one ACP test passed again, exit 0.

Tests use isolated temporary profiles, actual local HTTP/stdio MCP connections, official Harness, scripted model responses, frozen SDK Zod schemas and the original renderer adapters. They cover one connection, denied approval, scope isolation, child inheritance, reads during an active prompt, cancellation, actual stdio PID exit, reconnect, HTML CRUD, restart cache, and renderer consumption of structured outputs and app resource metadata.

These results exclude actual Electron miniapp interaction, external MCP services, cloud model app selection, and macOS acceptance. The frozen initial chat-result adapter consumes only the app resource marker; subsequent app `tools/call` responses preserve complete `_meta`. Policy replacements and MCP errors retain final Harness failure/presentation facts rather than inventing successful receipts.

## References

- [Official MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) and [SDK/specification](https://github.com/modelcontextprotocol/ext-apps).
- Pinned DeepSeek Harness `0.2.1-alpha.2`: `dsh-mcp-client`, `dsh-mcp-resources`, and `dsh-tools`, MIT license. This version omits Apps metadata in its client bridge; the host adapter supplies that compatibility layer without modifying vendored packages.
