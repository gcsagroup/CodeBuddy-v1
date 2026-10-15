# Runtime integration for security detection settings

Target: current files in `D:\CodeBuddy-v1`; source identity is recorded in [source-baseline.json](source-baseline.json). This batch adds `runtime/safety-policy.mjs` and tests. It does not modify the renderer, old Rust core, or permission ownership. No dependency installation, commit, or push was performed.

The existing UI is `SecurityToggle.tsx`. Existing `crates/goose/src/security/{mod,scanner,classification_client,command_chunker,security_inspector}.rs` establishes the contract: with the master switch enabled, inspect shell calls before execution. The command classifier receives the original command; the prompt classifier receives the last ten user texts. A score strictly above the threshold escalates to RequireApproval. The default threshold is 0.8. A model mapping or full endpoint selects a dedicated classifier, not the current conversation model.

The adapter preserves the structured classification protocol and score combination. It adds classifier HTTP requests when configured, without a second agent or model scheduling loop. Hugging Face uses `{inputs,parameters?}` and label/score responses. The adapter accepts both the original nested response and the current flat response, original INJECTION/SAFE and LABEL_1/LABEL_0 labels, and stable softmax for logits. Unknown labels, nonfinite scores, and malformed responses remain incomplete detection rather than a clean result. [Official API](https://huggingface.co/docs/inference-providers/tasks/text-classification)

## Host integration

```js
const safety = new SafetyPolicy(store, {
  modelMapping: process.env.SECURITY_ML_MODEL_MAPPING,
  overrides: {
    promptEnabled: process.env.SECURITY_PROMPT_ENABLED_OVERRIDE,
    commandEnabled: process.env.SECURITY_COMMAND_CLASSIFIER_ENABLED_OVERRIDE,
  },
});
const finding = await safety.inspect({ tool, userMessages, signal });
```

Retain the actual `{id,name,arguments}` tool. Only exact native `pwsh`, `bash`, and host legacy `shell` names apply; `arguments.command` is passed unchanged. MCP name suffixes are not used to infer shell identity. The host supplies `userMessages` in chronological order from explicit user message roles, excluding tool responses and assistant content. The service takes the last ten.

Apply disabled-extension, never_allow, chat, and other denial conditions first; then inspect; only afterward consider always_allow/auto. A true `requiresApproval` must trigger the existing approval channel for that specific call. Previous always-allow permissions cannot bypass a new finding, and approval of one finding must not create a future security exemption. This module does not execute, grant, or deny tools itself and does not change task completion state.

Results contain `status`, `requiresApproval`, `confidence`, `threshold`, `reasonCodes`, `explanation`, optional `findingId`, `classifierScores`, and `coverage`. Status is disabled, not_applicable, clear, flagged, or unavailable. Clear means only that the configured score did not exceed the threshold; existing tool permissions still apply. External cancellation throws AbortError instead of producing an approval request.

## Configuration, privacy, and behavior boundaries

- No corresponding text is sent when the master switch is off, the tool is inapplicable, or that classifier is disabled. Endpoints come from explicit configuration or explicitly supplied organization mappings. The adapter does not borrow the main model, download a model, or discover another service.
- Command windows retain 500 UTF-8 bytes with 256-byte overlap and a maximum of 12 windows, preserving character boundaries. Each recent user text is limited to 64 KiB; an excess means incomplete coverage. Each classifier uses at most three concurrent requests, a five-second request timeout by default, and a 64 KiB response bound. Score combination retains the existing command-primary and prompt-secondary behavior.
- Tokens are decrypted from existing protected storage only for in-memory Bearer headers, with configuration changes reloaded. URL credentials and HTTP redirects are rejected. Original texts, tokens, and service response bodies are not logged. Only explicitly enabled classifier paths issue requests.
- **Deliberate difference from the old fallback:** the adapter does not copy regex patterns. With detection enabled, a missing command classifier, missing endpoint, service failure, failed window, or unscanned tail returns unavailable and requires confirmation for this call. Unknown coverage is not fabricated into malicious probability or a clean score. Prompt-only classification lacks the command-primary signal and preserves this incomplete boundary. This is not an equivalent port of the old pattern-only detector.
- Configured external classifiers can still produce false positives and negatives. Their output escalates approval; it is not an OS sandbox, semantic authorization judgment, or guarantee of blocking every injection.

## Validation

From `runtime`, `node --test tests/safety-policy.test.mjs` passed 7/7 with exit code 0. Tests use controlled loopback HTTP services and actual DPAPI protection/unprotection of a fixture token. They do not call the user's classifier or real main model and do not execute classified commands.

Coverage includes immediate switch/threshold changes, classifier-specific text disclosure, last-ten selection, organization mappings, original payloads, UTF-8 windows, unscanned tails, partial failures, unknown labels, response limits, redirects, timeouts, cancellation, probabilities, and logits. Actual desktop alerts and the user's classifier require separate integration acceptance; these module tests do not establish permission-flow integration.

References: the existing Goose source above and its Apache-2.0 license; [Hugging Face Text Classification](https://huggingface.co/docs/inference-providers/tasks/text-classification). The implementation reuses the original protocol, standard Node fetch, and the existing credential module, without new third-party dependencies.
