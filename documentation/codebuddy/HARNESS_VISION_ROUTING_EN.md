# Harness auxiliary vision adaptation

2026-11-23: New profiles default to `auto` (main model first). A confirmed image-capable chat model receives the original images; otherwise the configured backup image model is used. Existing saved dedicated-model and main-only choices are preserved and can be changed in Settings → Image understanding. Windows and macOS share this initialization logic.

Date: 2026-10-14. Source: current files in `D:\CodeBuddy-v1`, which has no Git revision. This batch contains no commits, pushes, or renderer source changes.

## Behavior and ownership

The existing settings UI's `visionRoute` now affects real requests. `runtime/vision-routing.mjs` adapts user-message images only. It does not interpret task intent, decide task completion, or run another agent loop.

| Route | Behavior |
| --- | --- |
| No images | Pass the original content array to the main model without an auxiliary call |
| auto | Pass images directly when main image input is explicitly supported; otherwise use the configured auxiliary model with explicitly supported image input |
| always | When auxiliary vision is enabled, use it for every image input, even if the main model supports images |
| disabled or not enabled | Use only the main model; unknown/unsupported image input produces an explicit error |

Capabilities come from the current resolver and saved user overrides, not guesses based on model names. Saving an enabled route requires explicit provider/model selection and a configured connection. Image capability is checked at execution time so configuration save order does not deadlock.

The official Harness runs the auxiliary request in an independent session with no tools, `toolFilter.allow=[]`, no MCP, one model step, 1024 output tokens, and automatic compaction disabled. Every permission request is denied. Any attempted tool call invalidates the description. Only a normal stop with nonempty text produces an observation.

Original images remain in product messages, the unchanged renderer adapter, and exported history. The main model receives a replacement containing an explicit untrusted-data warning and a JSON-wrapped observation. This is not tool evidence, authorization, or proof of development completion. Follow-up turns restore the observation text from Harness history without automatically reinterpreting images or replaying side effects.

## Bounds and lifecycle

- Each auxiliary input allows up to 8 images, 8 MiB each, and 32 MiB total; quoted user text is limited to 32000 characters and observations to 16000 characters. Official attachment admission additionally verifies actual image formats and pixels.
- Independent 90-second timeout. Cancellation, timeout, and service shutdown propagate AbortSignal and await actual driver quiescence. Partial output, empty responses, model errors, and tool attempts never become successful descriptions. Active auxiliary providers are protected from configuration changes.
- Independent sessions are absent from the product session list. Harness session journals and standard attachment storage remain in the current profile. The driver has no per-session physical cleanup API, so this implementation does not promise zero retention.
- The original Rust `vision_service.rs` also handles screenshot targeting, coordinates, screenshot generation bindings, state verification, caching, resizing, and retries. This module does not migrate those computer-control capabilities; it implements user-image interpretation only. Computer control requires separate adaptation and acceptance.

## Automated verification and product boundary

Command: `node --test runtime/tests/vision-routing.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/tests/vision-routing-acp.test.mjs`. This batch passes 11 tests with exit code 0: 7 routing/state unit tests, 3 official Harness tests against local HTTP model fixtures, and 1 actual ACP integration test.

Coverage includes plain text/direct main/always routes, untrusted wrapping, configuration and capability checks, image admission, absent tool schemas, tool-attempt rejection, empty output, errors, cancellation, timeout, closed HTTP streams, provider protection, original renderer image consumption, and restart/export/follow-up behavior. Fixtures use temporary profiles and local controlled model services. These results do not establish actual Electron upload interaction, external vision-model quality, or macOS acceptance.

## References

Uses the installed DeepSeek Harness `0.2.1-alpha.2` and its MIT-licensed attachment/session execution design, without new dependencies or vendored changes. The [official attachment architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md) describes admission, normalization, and persistence ownership. The [official attachment package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/README.md) provides interface context. The locally pinned version and test receipts determine the verified behavior.
