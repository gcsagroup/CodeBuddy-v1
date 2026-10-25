# SecVibe integration with CodeBuddy: technical research

Date: 2026-10-23, Asia/Shanghai. Target: https://secvibe.gcsa.com/.  
Local architecture inspected: `D:\CodeBuddy-v1`, `main / 09b0219`, with existing uncommitted work preserved.  
Status: research and proposed design; no integration or security-detection acceptance has been performed.

## 1. Executive conclusion

The intended feature is a security review loop: after CodeBuddy changes code and runs functional tests, submit the authorized changes and necessary context to SecVibe, receive findings and evidence, let CodeBuddy repair them, then test and review again. Deliver the code together with a scoped security report.

DeepSeek Harness retains ownership of execution, scheduling, permissions, recovery and task completion. SecVibe supplies external review results. Existing integration mechanisms are reusable, but a critical prerequisite remains unverified: a supported third-party audit API/MCP, its result contract, and commercial integration terms. A complete security-agent product does not itself establish an open audit API.

## 2. Verified observations and gaps

| Topic | Observation |
| --- | --- |
| Product | The site describes a security coding workbench based on Pi Harness. Its agent center lists code auditing, remediation, language-specific security, and supply-chain/secret checks. These are vendor claims, not measured detection results. |
| Read-only audit | The `security-audit` detail lists reading, searching, Git inspection and report-artifact tools. A read-only first integration is appropriate. |
| Release | The site and release manifest show 0.1.1, minimum Node 22.19.0, and a CLI distribution. A stable noninteractive audit-output contract has not been tested. |
| API keys | With user permission, the existing signed-in Chrome session was inspected. The API keys/endpoints page explicitly configures model-provider credentials; it is not third-party audit API documentation. |
| Audit API/MCP | The inspected public pages, agent center, signed-in model/general settings, About page, release manifest and search did not establish a supported interface. A private offering may exist. |
| Cloud data | The privacy policy states that project content is processed in the cloud and relevant context may be sent to the selected model provider. |

Sources: [official site](https://secvibe.gcsa.com/), [release manifest](https://secvibe.gcsa.com/downloads/latest.json), [privacy policy](https://secvibe.gcsa.com/privacy/zh-CN/). No keys were created, configuration changed, source uploaded or CLI installed. Unrelated similarly named products and statements generated in the user's existing chat were not treated as implementation evidence.

## 3. Proposed architecture and options

```text
User request / enabled project review policy
→ CodeBuddy Harness tool execution
→ Thin SecVibe adapter, if needed
→ Official MCP service or audit API
→ Structured findings + report + source snapshot identity
→ Harness-driven repair → functional tests → recheck → delivery
```

Prefer an official MCP service using the existing bridge. A stable HTTP audit API is the next option, exposed through a thin Harness tool, reusing a vendor SDK if available. A CLI is a fallback only after noninteractive arguments, output schema, exit codes, cancellation and distribution rights are established. An interactive-only product can serve as a manual review entry, not a promised automated loop.

MCP defines discovery, invocation and structured tool outputs, making it a suitable integration mechanism. This is not evidence that SecVibe implements MCP. [Official MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Do not embed an additional SecVibe/Pi execution core or create another scheduler. External scan-job status is distinct from Harness task completion. The first version can use existing tool records, chat and report files; a dedicated findings panel is optional follow-up work.

## 4. Existing modules to reuse

- `runtime/harness/profile.mjs` and `index.mjs`: plugin composition, agent and tool execution.
- `runtime/harness/mcp-bridge.mjs`: MCP connections, tool registration and invocation.
- `runtime/harness/mcp-tasks.mjs`: Tasks only when genuinely negotiated with the service.
- `runtime/mcp-settings.mjs`: current synchronous default of 300 seconds; timeout must not become a clean scan result.
- `runtime/harness/tool-discovery.mjs`: load tool definitions on demand instead of injecting a full rule catalog each turn.
- `runtime/secrets.mjs` and `settings.mjs`: existing credentials/configuration boundary; credentials stay out of prompts and ordinary logs.

## 5. Proposed contract and reliability requirements

These are adapter requirements, not documented SecVibe fields or endpoint names. Inputs should identify the project, request, base revision, hashes of dirty/new files, authorized file manifest, related context and review categories. Results should identify the scan, execution status, coverage and gaps, report, and cost/timing when available. Findings should carry stable IDs, relative paths/lines, rule or CWE, severity, evidence and remediation advice. Preserve confidence only if the provider defines it.

Bind every report to the exact scanned snapshot. Changes during scanning invalidate its currency; review the repaired snapshot separately. Distinguish authentication errors, rate limits, timeouts, cancellation, partial coverage, and successful scans with no findings. An empty array must not conceal failure. No findings means no issues detected within stated coverage, not proof of absolute security.

Use negotiated Tasks or vendor job IDs for long scans, cancellation and resumption. Follow documented idempotency semantics to avoid duplicate uploads, scans and charges. A diff alone can miss cross-file risks, so include authorized supporting context. If only whole-repository upload is supported, revisit the data scope and cost before proceeding.

Treat external reports as untrusted data, not new execution permission. Harness performs repairs using existing tools and permissions. Begin with explicit user-invoked review; enable automatic review for selected projects after acceptance. A mandatory delivery gate requires an agreed project policy wired into the existing lifecycle. A prompt alone is not a reliable gate. No public protocol or completion semantics are changed by this research.

## 6. Data boundaries and acceptance

Exclude unrelated directories, build caches, actual credentials and escaping symlinks. Use synthetic secrets for tests. Confirm destinations, retention, training use, deletion and commercial terms. Running a local CLI does not establish that code stays local.

The Cloud privacy policy, dated 2026-09-26 on the page, describes cloud processing, possible forwarding of relevant context to chosen model providers, retention until deletion/account removal, and limited additional retention for some backups/security records. These are policy statements, not independently verified operations; commercial audit API terms still require confirmation. [Source](https://secvibe.gcsa.com/privacy/zh-CN/)

Implementation sequence: obtain official contracts/test access → demonstrate one isolated scan/repair/recheck → integrate settings, discovery, results and errors → validate larger projects, disconnections, cancellation and deduplication → approve automatic policy. Test known vulnerable samples, repaired versions and clean controls. Check locations, evidence, false positives, cross-file coverage, stale reports, functional regressions, timing and cost. Estimate delivery after the interface and minimal proof are established.

## 7. Questions for the provider

Request official API/MCP/CLI documentation and a minimal example; authentication and test quota; input formats, languages and size limits; structured JSON/SARIF findings and failure examples; asynchronous status/cancellation/idempotency; data destinations, retention and private deployment options; pricing, redistribution rights, version compatibility and support.

Suggested management update: “The goal is to add an external security-review loop to CodeBuddy while keeping Harness in control. I verified SecVibe's product capabilities and CLI release, but have not established a supported third-party audit interface. Model API credentials are a different feature. The next step is to obtain the official integration and data contracts, prove an isolated scan/repair/recheck, and then enable the product workflow.”

Only the three report files were added. No business implementation, audit execution, dependency installation, commit or push occurred. See the [full Simplified Chinese report](secvibe-integration-research.zh-CN.md).
