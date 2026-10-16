# MCP discovery and Gemma reasoning acceptance (2026-10-15)

Candidate 1.43.3-harness8, based on main / 01610d0 plus this uncommitted change set.

Installed Harness 0.2.1-alpha.2 has no ready-made general tool_search plugin. A thin adapter uses its official system-prompt/assemble hook to project selected MCP schemas. search_mcp_tools loads at most five per call and retains sixteen per session. The canonical registry, toolbox inventory, permissions, execution, compaction and completion remain native. Existing HTTP preset connections remain shared; session-specific stdio connections remain isolated. Restart restores selected schemas, without treating legacy full-catalog headers as selections. Read-only observers without MCP receive no discovery tool.

Capacity comes from endpoint model metadata: current Gemma LAN advertises 65536. Services without capacity metadata retain the conservative 32768 adapter fallback, not a claim about their theoretical maximum. System instructions and schemas also consume context. Gemma now uses the official pi-ai chat-template enable_thinking flag: none disables it and supported non-off levels enable it; distinct intensity levels are not claimed. General guidance discourages unrelated workspace inspection and repeating successful empty-output commands, without keyword routing or host-invented completion.

Of 369 automated regressions, 367 initially passed. The new Gemma fixture omitted requiresAuth:false; an existing Git assertion counted read-only capacity discovery as a completion. After correcting the fixture and asserting actual completions, all five affected tests passed, exit 0. Coverage includes a 200-tool catalog, denial, shared connections, restart and native repeated compaction. Logs: discovery-full-tests2.log and discovery-repaired-tests.log under .preview-evidence.

Real isolated service acceptance: Gemma cold/warm new sessions appeared in 8/9ms, first reasoning in 11.1/2.1s, first answer text in 14.2/14.6s, with 9896 input tokens each. Kimi cloud first answer was 7.5s, input 9302. All ended normally without greeting tool calls. First requests carried 43 base tools and zero full MCP schemas. Gemma also searched for and actually called the time tool. These are individual samples, not latency guarantees. Evidence: .preview-evidence/discovery-real-nQL0Zr/receipt.json.

Installer build and actual installed UI results will be appended after verification. Source-level validation does not establish installed acceptance.

## Installed results

build-harness-windows.cjs and the actual --silent upgrade both exited 0. Bundled Node, native subprocess and service startup gates passed. Installed EXE, app.asar, Harness manifest and every changed runtime file match this candidate/current source. Installer: target/accepted-harness-installer-1.43.3-harness8/CodeBuddy-Harness-Setup.exe, 325128192 bytes; SHA256 FD45E62AF22FD10324CB589D85E3B5258655ACA45A12D9F8FF2969EF136F5CB7.

Actual installed Electron controls: two greetings opened conversations in 1001/956ms, first reasoning chunks in 6.10/2.85s, first answer chunks in 10.39/8.49s, both end_turn, with 10k / 66k shown. A calculation follow-up visibly streamed reasoning from 616ms with 30 distinct sampled lengths, and completed thoughts expand correctly. MCP discovery followed by a real time-tool call succeeded; native headers contained zero MCP schemas initially and five after search, with no tool errors. Switching to Kimi through the UI retained the calculation result 391, finished in 7.1s, and showed 13k / 33k.

Evidence: .preview-evidence/harness8-ui-*.json, harness8-installed-native.json and harness8-installed-identity.json. The initial isolated fixture omitted its version field; a UI probe initially selected a hidden previous-chat node. Both fixture issues were corrected before acceptance, without changing product behavior to accommodate them. This is a Windows candidate; hour-scale project and macOS acceptance were not repeated. Model reasoning and network latency remain. This change set is not committed or pushed.
