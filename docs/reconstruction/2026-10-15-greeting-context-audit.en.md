# Greeting context audit

2026-10-15. Session: `411ca1a4-5bb7-4048-bc5a-49b25f36e62d`, kimi-k3, 16:29 local time. Running candidate: 1.43.3-harness8. Workspace: D:\CodeBuddy-v1, main / 01610d03764570282eee439cd2bfb49fcd373e98 plus existing uncommitted changes. Installed index, profile, discovery and compat files match the working tree hashes. This investigation did not change product code, restart the application or make another model request.

The native log contains one request and no tool calls. The user supplied only “你好”. Provider usage is 6,638 input, 101 output, 6,739 total. The composer receives 7,927 with source local_estimate and capacity 32,768.

| Component | Characters | Harness estimated tokens |
| --- | ---: | ---: |
| 43 tool schemas | 24,840 | 6,214 |
| System prompt | 6,026 | 1,511 |
| Runtime context | 458 | 123 |
| Greeting | 2 | 9 |
| Assistant text and reasoning | 151 + 78 | 70 |
| Total | | 7,927 |

These are character-density estimates including framing, not provider tokenization by component. The estimate exceeds the provider total by 1,188 (17.6%). Schemas account for approximately 78% of the estimate. They comprise 23 native tools enabled by this product profile (14,702 characters), 14 CodeBuddy Git adapters (4,243), four role-specific native subagent registrations (4,674), project memory (439), and MCP discovery (738). The native set is a profile choice, not a universal Harness minimum.

There are 163 discoverable MCP tools but zero MCP schemas in this request: schema discovery is working. However, the MCP client separately injects server instructions into the system prompt. The autovisualiser introduction and eight-tool summary remain present (approximately 1,204 characters). The prompt also contains two similar CodeBuddy identities (202 and 258 characters), 1,111 characters of memory instructions despite empty records, and 808 characters of CodePro guidance. There is no old conversation, project source or full skill body in this request.

The installed native token meter retains its estimate when provider usage is below the estimated anchor. CodeBuddy forwards that conservative value and labels it local_estimate, but the frontend does not project the source marker. The old Rust ordinary-response path stores provider usage and displays session.usage.total_tokens. These are different measurement semantics; an equivalent old-version model/plugin/configuration comparison was not available, so smaller historical real requests are not established. The 32,768 capacity is the adapter fallback when capacity metadata is missing, not a universal Harness limit or verified Kimi capacity.

The combined causes are always-declared native and adapter tools, additional prompt sections, and an unlabeled conservative estimate. Proposed follow-up: extend lazy projection to optional Git/role groups, load capability instructions with their tools, deduplicate identity and shorten empty-memory instructions while retaining permission boundaries, and distinguish actual usage from budgeting estimates. Preserve native Harness registration, authorization, execution and compaction; do not introduce greeting keyword routing or lower safety budgets merely to reduce the displayed number. Verify discovery, Git, memory, roles, desktop control and long tasks before claiming functional equivalence or token/latency targets.

Evidence: actual native session log and selected saved usage fields; `.preview-evidence/hello-context-audit.mjs` exited 0 and exactly reconstructed 7,927 in `.preview-evidence/hello-context-audit.json`, without credentials. No fresh model/E2E acceptance was performed. Three diagnostic documents and ignored local audit artifacts were added; no commit or push. Detailed source references and reasoning are in the simplified Chinese companion document.
