# Skill management and toolbox localization

Date: 2026-09-05. Status: written specification approved; development, testing, and acceptance authorized by the user.

[繁體中文 (default)](2026-09-05-skill-management-design.md) · [简体中文](2026-09-05-skill-management-design.zh-CN.md)

## Goal and evidence

Users can create, download, inspect, edit, and delete skills through either the UI or conversation. Toolbox content follows the selected language. AI-initiated deletion requires user confirmation of the exact target.

ToolboxView renders raw names and descriptions instead of reusing the localization in SkillsView and ExtensionList. The acceptance skill also has an English source description. sources.rs provides some filesystem CRUD, but this does not establish complete UI, download, or conversational management. Its existing deletion removes the directory directly and is not recoverable.

Use a shared Rust management service through ACP and AI tools, retaining existing discovery and storage. UI-only changes do not support conversation; arbitrary AI file operations cannot provide consistent permissions, conflicts, or refresh behavior. Adopt the publicly documented SKILL.md format, explicit/implicit invocation, scopes, and separate presentation metadata from [OpenAI's skills documentation](https://learn.chatgpt.com/docs/build-skills), consulted 2026-09-05. Do not infer private internals, copy storage, build a plugin marketplace, or claim that all Codex management behavior was tested firsthand.

## Functional contract

1. Provide search, source/scope filters, details, creation, local import, and link download. Toolbox skill cards open the same management surface.
2. Edit identifiers, descriptions, instructions, and display metadata with project/user scope. Validate frontmatter, preserve unknown fields and companion resources, and never silently rename an existing identifier. Built-in/read-only sources support inspection and an editable copy, not direct modification or deletion.
3. Import a SKILL.md file or full skill directory. Initially support GitHub skill-directory URLs and direct HTTPS SKILL.md URLs. Resolve GitHub sources to a commit and retain provenance; explain that direct-file downloads include no companion files. Clearly reject other formats. Leave required authentication to the user without searching for credentials.
4. Preview provenance, destination, files, and conflicts. Do not overwrite by default; offer cancellation or a new name. Overwrite requires a diff and confirmation. Stage and validate before publishing; failure preserves the existing installation. Never execute downloaded installation scripts.
5. Show the exact deletion target, source, and scope. After confirmation, move it to an application-managed recovery area and support restoration without overwriting conflicts. Permanent purge and changes to unrelated deletion API semantics are out of scope.
6. AI install/edit/delete use the same service. Overwrite/deletion require a real user confirmation event bound to the exact preview, not a model-supplied confirmed flag. Cancellation causes no mutation; a changed target version requires a new preview and confirmation.
7. Refresh discovery and toolbox state after mutation. The next conversational request sees updated state; do not silently replace instructions in an active turn. Deleted skills cannot be newly loaded; restored skills become available again.

## Localization and safety

Translate owned UI, statuses, action feedback, and built-in skill/tool presentation into Traditional Chinese, Simplified Chinese, and English; update immediately on language changes. Other existing locales retain explicit English fallback. Preserve third-party brands, protocols, and stable identifiers. Support localized display metadata and original-content inspection; label missing translations and allow display metadata editing. Do not silently rewrite executable instructions, upload skill contents, or promise automatic translation of arbitrary third-party content.

Identify targets by resolved source path and scope, not name alone. Revalidate authorization, target version, and content fingerprint before mutation. Reject path traversal, symlink escapes, invalid skill formats, excessive download size/file counts, and timeouts. HTTPS requests and redirects must reject local/private network destinations. Do not broaden AI filesystem grants or read-only conversational permissions.

## Service boundaries

Rust owns source identity, listing/reading, preview, apply, recovery, and restore. ACP and AI tools handle authorization and typed adaptation without another skill store. Reads return a source reference, scope, read-only status, version, and original/display metadata. Previews return targets, diffs, conflicts, and a constrained operation token; apply checks the token, version, and user confirmation event again. Success returns the actual destination and updated version; deletion additionally returns a recovery reference.

Use existing ACP error transport with stable categories for invalid input, read-only sources, conflicts, missing authorization, and download failures. Translate categories in the UI and avoid credential exposure in details. Reuse existing types, extend contracts additively and regenerate the SDK when necessary; do not introduce the retired OpenAPI client.

## Sequenced acceptance

1. Localization: add regression tests, fix toolbox mappings, and verify three locales plus unchanged identifiers.
2. Local management: creation, import, inspection/editing, duplicate names, read-only sources, cancellation, traversal, version conflicts, recovery/restore, and reload consistency.
3. Downloads: valid sources, companion files, limits, network failure, malicious paths, redirects, partial failures, and overwrite rollback. Perform a real download followed by conversational invocation.
4. AI management: registration/routing, authorization wait/cancel, forged confirmation rejection, and re-confirmation after target changes. Match natural-language operations to actual tool records.
5. Full gates: relevant Rust/desktop suites, typecheck, lint, format, and build; update and execute goose-self-test.yaml. Launch Electron from changed source and use real mouse/keyboard interaction to verify reload, restart, files, conversation, and logs.

Resolve new regressions before starting the next stage. Record commands, cwd, exit codes, and passed/failed/skipped counts. Authentication, download permissions, or unavailable desktop automation are verification blockers, not passing tests. Use isolated acceptance data, preserve existing MCP and user skills, and do not create branches, automatically commit, or push.

## Display metadata clarification (2026-09-05)

Official UI names/descriptions live in optional `agents/openai.yaml.interface`; the local bundled skill-creator exposes that format too. [Official documentation](https://learn.chatgpt.com/docs/build-skills)

Adopt presentation/identity separation, not a second storage layout: reuse `SKILL.md` at `metadata.codebuddy.display`, mapping locales to `{name, description}`. This is a CodeBuddy convention, not an OpenAI standard. ACP returns typed display data and complete original metadata; only explicitly submitted display fields merge into the corresponding node. Preserve unknown sibling fields, other locales, original body and companions; reject incompatible node types explicitly. Never change stable `name`. Missing current-locale values fall back to original text without claiming translation.
