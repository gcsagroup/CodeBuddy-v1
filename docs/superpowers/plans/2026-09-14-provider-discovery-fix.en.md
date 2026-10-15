# Custom provider connection fix

Date: 2026-09-14. Status: source fix and development desktop acceptance passed; installer not updated.

## Problem and behavior

After fetching a valid catalog, the old flow probed the alphabetically first model. If that model failed, the entire catalog was hidden, preventing selection of healthy models on the same gateway.

Discovery now only sends a GET request. Creating, updating, or activating a provider still requires a minimal inference request using the selected model. The UI says the catalog was loaded, without claiming credentials or every model were verified. A failed save preserves the catalog so the user can select another model.

The model selection dialog after saving also prefers the configured default when it remains in the live catalog, preventing built-in brand preferences from replacing the just-validated selection. Existing explicit selections are preserved.

## Reference and boundaries

The [published OpenAI Models API](https://platform.openai.com/docs/api-reference/models/object?lang=curl) separates listing models from making inference requests. We adopt that separation. Private Codex implementation is unavailable and is not inferred. We reject automatic model traversal, silent model fallback, and treating a public catalog as credential verification. Existing protocols and ACP schemas remain unchanged.

Gateway model errors such as 502/429 and unsupported protocols remain independent issues. Authentication rejection, empty catalogs, invalid responses, timeout and response-size checks remain enforced.

## Validation

Regression coverage includes mixed healthy/broken models, public catalogs with invalid keys, successful HTTP without completion content, Ollama, selected-model saving, activation, and changing selection after a failed save. Automated, real-gateway, and native Electron acceptance results are recorded separately under `.cargo/evidence/gateway-107-20260914`; running checks are not passes. The installer has not been updated yet.

## Acceptance results

Refreshing the provider catalog now preserves the model selection dialog, including refresh failures and retries.

ACP integration: 59 passed. Core goose library: 3286 passed, 2 ignored. Format, Clippy and CLI build passed. Related UI suite: 14 files, 79 passed. Refresh-related suite: 4 files, 37 passed; final state-retention suite: 5 passed. TypeScript, full ESLint and locale checks passed.

Real 9.107 gateway: catalog discovery, ollama-dev save, activation and CLI reply OK passed. Native Electron with the rebuilt backend passed connection creation, recovery from Gemini save failure, stored-key catalog discovery, update, automatic dialog retaining ollama-dev, activation, a conversation showing 连接成功, and reload retaining the conversation and model.

Tests used the isolated D:/CodeProAcceptance/gateway-107-20260914 profile. An early CLI fixture used the goose keyring service while Electron uses codebuddy; its missing-key warning was a test namespace mismatch. The connection created entirely through Electron worked. Gemini upstream errors remain separate. The gateway and installed application were not changed.

Evidence: `.cargo/evidence/gateway-107-20260914/native-observations.json`, `native-reload.json`, `fixed-backend-probes.json`, `rust-gates.json`.
