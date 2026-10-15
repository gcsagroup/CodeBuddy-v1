# CodeBuddy Settings Center Redesign

## Goal

Replace the current implementation-oriented horizontal tabs with a user-goal-oriented settings center. Preserve all existing model routing, local inference, provider, permission, memory, credential, extension, and application behavior.

## Confirmed decisions

- Use grouped sidebar navigation with settings search.
- Settings manage model connections and agent routing; the settings center does not expose a GGUF/HuggingFace downloader.
- Regular users see only **CodeBuddy Model** and **Custom Connection**, not a vendor marketplace.
- CodeBuddy Model remains visibly unavailable and labeled “In development” until it is real.
- Custom connections support local, LAN, and self-hosted public endpoints. OpenAI-compatible transport is the default; discover models through `/v1/models` and allow manual model IDs when discovery is unavailable.
- Keep unavailable capabilities visible with a reason and recovery action instead of silently removing their pages.
- Move system prompt templates to Advanced. Regular users customize behavior under Behavior & Responses.

## Information architecture

### Common

- **General**: startup, window behavior, sleep prevention, and cost display.
- **Appearance & Language**: theme, locale, and display preferences.
- **Notifications & Updates**: task notifications, OS notification entry point, version, and update policy.

### AI

- **Models & Runtime**: active model, health, quick switching, and Model Console entry point.
- **Behavior & Responses**: default mode, response style, tool-detail presentation, spellcheck, and project hints.
- **Memory**: project memory status and readable CRUD; quotas, expiry, export, and cleanup move to Advanced Management.

### Connections & Security

- **Tools & Connections**: extensions, external backends, and connection health.
- **Accounts & Credentials**: GitHub and custom-endpoint secrets; never reveal secret values.
- **Permissions & Privacy**: tool permissions, read-only classification, workspace authorization, telemetry, and data boundaries.

### Advanced

- **Keyboard Shortcuts**: global, application, search, and window shortcuts.
- **System Prompt Templates**: diff, validation, save, and reset.
- **Developer & Diagnostics**: raw configuration, capability metadata, logs, and redacted diagnostics export.

## Shell and navigation

Use a fixed grouped sidebar and a single content page. Search results show a setting name, description, and breadcrumb. Each setting declares its scope and when it takes effect. Preserve existing deep links through a compatibility map. Show status cards only when action is required.

## Models and runtime

The settings summary shows the active model, configured connections, Switch Model, and Agent Model Configuration.

Models and runtime has two source types: the in-development CodeBuddy Model and user-named configured connections. The connection wizard selects Ollama or OpenAI-compatible transport, collects a base URL and optional secret, verifies the model-list endpoint, and lets the user select a discovered model. Manual model ID appears only when discovery fails. The wizard does not send potentially billable inference requests; streaming and tool calling are verified in a real session.

Errors distinguish refused connections, timeouts, TLS, authentication, missing model discovery, unknown models, transport incompatibility, and tool-call incompatibility. A failing connection cannot become the default.

Public endpoints require HTTPS. HTTP is allowed only for loopback and explicitly confirmed LAN addresses. Secrets use the existing secure store and never enter project files, logs, or diagnostics exports.

## Memory and prompts

Memory first answers whether it is enabled, which project it affects, what is remembered, and how to change it. Turning memory off does not delete records. Individual deletion and project reset are separate confirmed operations. Mandatory `AGENTS.md` instructions remain distinct from recallable memory.

System prompt templates validate Jinja syntax, required variables, and a minimal render before save. The editor shows the default diff, risk level, and reset action. High-risk templates such as `system.md` and `permission_judge.md` cannot be saved after failed validation.

## State, compatibility, and errors

The UI consumes explicit capability states: `available`, `reason`, and optional `recoveryAction`; it does not infer build features. Model connections follow Draft → Verified → Saved → Selectable. Editing an active connection creates a draft and atomically replaces the live configuration only after verification.

Reuse current provider implementations, defaults, credential storage, and model directories. Keep old keys and project them through an adapter into custom connections. Remove vendor cards from the regular UI without deleting provider implementations. Do not make `localInference` presence the sole condition for rendering the entry point.

Preserve form state after failures. Treat login, permission, download, and security confirmation as resumable waits. Preflight disk space before model downloads. Before deletion, show path, size, loaded state, and default-model status. Redact secrets, tokens, request bodies, and user file content from diagnostics.

## Delivery sequence

1. Settings shell, grouped sidebar, search, deep-link compatibility, and capability state.
2. Models & Runtime, Model Console, and custom connection wizard.
3. Behavior & Responses, Memory, and Permissions & Privacy.
4. Tools & Connections, Accounts & Credentials, System Prompt Templates, and diagnostics.
5. Complete trilingual copy, migration verification, Release binding, and real Windows desktop acceptance.

Each phase must pass its own gates before the next phase begins. Do not replace the entire settings surface in one unverified change.

## Acceptance

Component tests cover navigation, search, deep links, unavailable capabilities, persistence, and destructive actions. Backend tests cover discovery, manual model IDs, authentication, TLS, timeouts, protocols, and atomic updates. Regression coverage preserves provider/model routing, local inference, permission waits, workspace authorization, memory persistence, credentials, and updates.

The packaged backend must advertise its compiled capabilities accurately. Run real Windows desktop flows for settings search, custom local connection, model switching, restart recovery, memory management, prompt validation, and reset. Repeat critical flows in the Release installer and record exact commands, exit codes, counts, and evidence paths.

## Non-goals

- No third-party vendor marketplace.
- No fake model or download endpoint before the CodeBuddy model exists.
- No inference-engine or provider-protocol rewrite.
- No changes to existing permission semantics, recovery state machines, or storage locations.

## Approved addendum: local connections and agent models

- Remove the GGUF/HuggingFace recommendation, search, and download UI from the model console without deleting compatibility code or existing user model files.
- Models and runtime shows only the in-development CodeBuddy model, configured connections, and the add-connection entry. It does not show a provider marketplace.
- Every model picker keeps separate Provider and Model selects. Provider lists only successfully configured, activation-enabled connections; Model lists only models discovered or saved for that provider.
- Provider always ends with “Use another provider…”. That action offers only recommended Ollama, OpenAI-compatible, and manual setup instead of the complete provider catalogue.
- Ollama defaults to `http://127.0.0.1:11434`. Test the connection before discovering models, and reveal manual model ID entry only when discovery is unavailable. A failed draft never replaces a working connection.
- After a connection is saved, return to the originating picker and select the new provider and model. Existing configured cloud connections remain selectable but are not recommended again.
- Replace Model console with Agent model configuration: one default agent model plus optional Planner, Coder, Tester, and Reviewer advanced routing.
- With advanced routing disabled, all four roles follow the default agent model. When enabled, each role uses its own configured provider and corresponding model. Internal helper models for session titles, compaction, and permission judgment remain hidden from ordinary users.
- When a connection or model becomes unavailable, show that state without silently falling back or rewriting the user's selection.

### Official behavior comparison and decisions

- Adopt Ollama's official `GET /api/tags` model-list contract and conventional local port `11434`; use the explicit `127.0.0.1` host in the UI default.
- Adopt OpenAI's official `GET /v1/models` and `data[].id` shape as the discovery contract for OpenAI-compatible endpoints.
- Do not infer or copy private Codex settings internals. Adopt only the observable principles of simple routine settings and hidden internal helper models.
- Reject a complete vendor marketplace, automatic large-model downloads, and inference requests during connection testing because they add cognitive load, disk use, or potential cost.

References: [Ollama List models](https://docs.ollama.com/api/tags), [OpenAI List models](https://platform.openai.com/docs/api-reference/models/list).
