# Tool session approval

Browser control, image generation, video generation, desktop pet creation and project memory share the existing approval card: Deny Once, Allow Once, and Allow this tool for this session. The runtime supplies available choices; the frontend does not manufacture grants.

A grant covers one tool in the current conversation, not other tools or conversations, and never becomes a global allow setting. Equivalent next-turn configuration preserves it. Removing a tool or changing its workspace, service or execution owner requires fresh approval. Restarting the application also requires fresh approval. Candidate memories still require separate review, and pets still require explicit user selection.

An MCP tool-list refresh preserves grants for unchanged definitions, argument schemas and metadata on the same connection. Changed or removed tools and reconnected services invalidate old grants.

Local MCP processes belong to the conversation. Prompt or model-context updates preserve healthy connections with unchanged configuration. Changing commands, arguments, environment or tool filters, or disabling the service, releases the old connection and grant. Explicit capability release also revokes builtin and native web grants before reactivation.

`list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource` are scoped independently by conversation, tool and server connection. Listing does not authorize reading, and another service does not inherit a grant. Image/video `inspect` operations share the corresponding tool's service grant. Old jobs on another service still require separate approval.

## Entry-point audit

| Entry point | Behavior |
| --- | --- |
| Embedded browser, images, videos, pets, project memory | Session grants; memory review and pet activation remain separate |
| MCP: isolated/user browsers, computer control, time/weather, PDF, charts and external services | Shared MCP approval path; destructive tools retain per-call approval |
| MCP resource listing, template listing and reading | Per-tool and per-server session grants |
| `web_fetch` | Origin-scoped grants with the native network fence |
| File/image reads, search, skills, dependency paths, ten read-only Git tools | Existing read-only policy, normally no approval card |
| File writes/edits, commands, working-directory changes | Native sandbox and per-operation escalation |
| Ten Git write tools | Existing destructive classification, per-call approval and preflight receipts |
| Questions, plan exit, goals, todos, jobs, subagent control, tool discovery | Native state machines and ownership checks; tool approval never replaces a user answer |

The audit covers current source registration paths and shared approval entry points. Third-party catalogs are dynamic. HTTP/stdio fixtures verify shared behavior without executing every external tool's real side effects.

Explicit ask-every-time settings, additional safety confirmation and destructive MCP annotations retain single-call confirmation. Native commands continue to follow Harness sandbox and approval rules. Explicit denial and disabled tools always override session grants.
