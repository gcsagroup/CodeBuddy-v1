# Reasoning budgets and ending reasoning

See [简体中文 (default)](REASONING_CONTROL_ZH_CN.md) / [繁體中文](REASONING_CONTROL_ZH_TW.md).

## Implemented scope

Following the separation used by pi-llama-cpp, reasoning allowances are distinct from total completion limits. CodeBuddy retains its existing official Harness / pi-ai adapter; it neither installs a second agent core nor injects closing reasoning tokens on the client.

The integration applies only to Chat Completions services identified as vLLM by their model inventory and advertising `thinking_token_budget` in OpenAPI. Capability discovery shares the connection inventory cache. Moving the effort slider does not generate completions. Failed or unknown capability discovery preserves the existing request dialect.

Per-request thinking ceilings are 512 tokens for minimal, 2048 for low, 4096 for medium, 8192 for high, and 16384 for xhigh. Models offering max use the same 16384 ceiling. The UI presents the levels available for each model. Disabling reasoning omits the budget. The native serializer reduces the ceiling to leave room for an answer when output space is limited. GPT and Ollama connections send supported effort levels through their own protocols.

Enforcement belongs to the server. Advertising a field does not prove that the deployed reasoning parser is configured correctly. Token limits are not wall-clock guarantees. Real streaming requests and completed tasks remain necessary acceptance evidence.

## Excluded scope

The immediate `reasoning_end` feature depends on llama.cpp's specific control endpoint. An equivalent endpoint has not been verified for the current vLLM or Ollama Kimi connections, so no ineffective button is exposed and Kimi effort is not silently reduced. Future support must bind control to the original session, run and completion ID and check the response success field, rather than HTTP 200 alone or the currently selected model.

Ending reasoning does not establish tool execution, file creation or passing tests. Permission failures, command status and incomplete exports require independent fixes and acceptance.

## Validation and references

In a live Gemma service probe on 2026-11-09, a budget of 64 produced approximately 62 reasoning-field tokens, but deliberation continued in the answer content until the 2048-token output limit was exhausted. The requested short answer was absent. Ending a reasoning block does not necessarily end deliberation, and smaller budgets do not guarantee a better outcome. A real project run also produced a checker with hardcoded successful results; execution and verification receipts must address that problem independently.

`runtime/tests/vllm-thinking.test.mjs` covers native serialization, disabled reasoning, caching, unknown services and legacy Gemma templates that ignore `reasoning_effort`. Automated tests do not establish installed Windows/macOS acceptance.

- [pi-llama-cpp](https://github.com/gsanhueza/pi-llama-cpp#reasoning-control) (MIT; design reference only, no code copied)
- [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [vLLM reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)
