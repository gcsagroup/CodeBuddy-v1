# Generation feedback and approved workflows (2026-10-23)

Source: main, initially f6d5317, then 09b0219 after another task committed. This batch remains uncommitted. Other task changes were preserved.

## Findings

The supplied pet session had two requests waiting 206286 ms and 122499 ms for HTTP response headers. Server queueing versus network/prefill time is unverified. Two other sessions took 1377089 ms and 714797 ms while receiving reasoning output (22026 and 16423 characters); their headers arrived in 19 ms and 56 ms. Streaming generation and pre-response silence require different feedback. The exported conversation repeats one timestamp, so native logs were used instead.

The character's first generated image had no original image reference. Later animation sheets reused that draft. Search success did not establish visual fidelity. The preview catalog also blocked on remote observation/download before returning local receipts.

## Changes

Explicit model-wait labels and a hint after 20 seconds without new activity reuse existing host facts and stop controls. The preview catalog returns local receipts immediately and refreshes in the background with existing deduplication. It shows actual node stages, queue position and elapsed time; no fabricated overall percentage.

Six fixed templates are bundled: qwen_image, qwen_edit, minimax_text, minimax_text_detail, minimax_image, minimax_reference. Existing templates remain preferred. With the user-approved fallback policy, callers may submit fallback_workflow only when every registered template for the current mode lacks installed nodes or model selections; the host rechecks /object_info at submission. Omitted dimensions/duration preserve template defaults. Explicit dimensions must match supported aspect ratios and at least 0.1 MP. One supplied reference occupies both reference slots where the template has two, preserving graph links and avoiding sample files.

The user explicitly approved one correction to QI2.1_i2i: node 459:453 changes the incompatible MiniMax 32B encoder to qwen3vl_8b_int8_convrot.safetensors. The original failed with expected dimension 4096 versus actual 5120. All other template structure and defaults are retained; original D:/ exports remain untouched. Corrected SHA256: 6e05bc8a3e62376e9ad80603f7f5eba8f25e0e1f73795da500ac194a4dcc59be.

Pet preparation now instructs the Agent to inspect real references for existing characters, show a draft and obtain likeness confirmation before generating animation states. This is workflow guidance, not a new enforced approval state machine. Character likeness still requires user acceptance.

## Evidence and limits

22 targeted runtime tests, 23 component tests, TypeScript checking and three real Edge language tests passed (exit 0). Browser screenshots include a simulated 206-second wait. These are component/browser checks, not installed-desktop end-to-end acceptance.

Real ComfyUI text-to-image job 57e1eec4-dec4-414a-a8a1-4fc0851ae650 completed at 512×512. The original edit template failed (9318d7bd-43a3-445a-af45-39ea77b4a178). After the approved correction, b7c30e5d-48e6-4e5a-a53c-0210a1ca3ede completed at 512×512; visual review confirmed the character remained and its blue scarf became red. This does not establish likeness to the user's named character.

Local artifacts: %TEMP%/codebuddy-approved-workflows-BB7oRB, excluded from commits. The initial pnpm test command unexpectedly synchronized dependencies and started postinstall; it was stopped and four deleted tracked SDK files restored. No downloads were reported, but node_modules was changed. Subsequent tests used existing local executables. Optional JSON fields and stale compiled translations found during testing were corrected.

No installer, installed-app restart, commit or push was performed. Remote model latency is not eliminated by UI changes. See the simplified Chinese report for full commands and source mapping. Official references: https://docs.comfy.org/development/comfyui-server/comms_routes and https://docs.comfy.org/development/comfyui-server/comms_messages.

Additional live acceptance: reference-to-video c2b7f86f-cfb0-4bf6-999b-edd59f80268f completed as a 512×512, 2.333-second MP4 (model frame-grid rounding). Edge played beyond 0.515 seconds with video.error=null; the screenshot was inspected. The other three video templates passed structural/parameter tests but were not individually generated in this batch.

## Conditional creation when no workflow is available

Both tools expose operation=inspect with matching templates, missing dependencies, creation_allowed, paginated node names and requested input/output schemas. The Agent composes from installed capabilities. The host checks graph size, connections, cycles, outputs, reference uploads and prompt/explicit parameter bindings; ComfyUI /prompt performs final validation. Network failures, queueing and execution errors never authorize replacement. No automatic installation or downloads. Existing receipt, polling, cancellation and artifact publication contracts remain in use.

Scope: the reusable catalog contains six CodeBuddy-registered exports, not arbitrary workflows saved in the ComfyUI frontend. Generated graphs and fingerprints remain in job receipts; they are not automatically added to the template catalog.

This round: 27 tests across six Node 24 files passed, exit 0, including Harness plus an isolated HTTP service, video submission and server rejection. Real read-only inspection found 960 node types and all six templates with available dependencies; creation_allowed was false for all five modes. No GPU fallback generation or desktop model-selection E2E was performed. The running desktop has not restarted to load this round's backend changes.
