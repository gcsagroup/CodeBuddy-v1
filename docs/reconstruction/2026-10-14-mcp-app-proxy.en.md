# MCP app proxy and isolated origin

`runtime/mcp-app-proxy.mjs` reuses `crates/goose/src/acp/templates/mcp_app_proxy.html`. Packaged builds use its exact copy at `runtime/assets/mcp-app-proxy.html`; tests compare both files. The renderer and message protocol remain unchanged. The existing template is covered by this repository's Apache-2.0 license. Official MCP Apps similarly use host-controlled sandboxed iframes and postMessage protocol transport. [Official overview](https://modelcontextprotocol.io/extensions/apps/overview)

Main integration creates `await createMcpAppProxy({secret})`. Before ordinary HTTP header authentication, dispatch matching `proxy.handles(req)` requests to `await proxy.handle(req,res)`; the module performs its own authentication and loopback check. Call `await proxy.close()` during service shutdown.

| Route | Authentication and behavior |
|---|---|
| Main-origin GET `/mcp-app-proxy?secret=...` | Verify the random backend secret; return the original proxy document with normalized CSP |
| Main-origin POST `/mcp-app-guest` | Secret in the JSON body; accept HTML/CSP and return `{nonce,guestUrl}` |
| Separate loopback-origin GET `/mcp-app-guest?nonce=...` | Read only temporary HTML for a random nonce; no backend, configuration, tool execution, or write routes |

The guest and proxy origins use different ports. Backend secrets are not injected into guest HTML. The existing template uses `sandbox="allow-scripts allow-same-origin allow-forms"` and validates actual postMessage window sources. Tool calls and resource reads remain subject to host permissions; this HTTP module has no tool approval or execution capability.

CSP domain parameters preserve supported HTTP(S)/WS(S) origins, DNS/wildcard subdomains, localhost, IP addresses, and optional ports. Paths are removed; policy separators, URL credentials, unrestricted wildcards, and invalid protocols are rejected. Proxy and guest responses disable caching. Guest CSP headers reject newlines and use a restricted policy when omitted.

Temporary storage retains the original 300-second TTL, 64-entry limit, and 16 MiB request limit, with an additional 64 MiB aggregate-content budget. Oldest entries are evicted when count or aggregate capacity is reached. Expired entries are pruned; close clears memory and releases the guest listener. No user files or HTML are written to disk.

Validation from `runtime`: `node --test tests/mcp-app-proxy.test.mjs`, 4/4, exit 0. Two actual loopback HTTP origins exercise the original template, authentication, separate read-only endpoints, CSP, real chunked-body overflow, TTL, count/byte eviction, and port closure. A combined run with conversation unit/integration coverage passed 10/10. HTTP tests do not establish browser sandbox behavior or real third-party app interaction; main integration must validate those in the unchanged desktop.
