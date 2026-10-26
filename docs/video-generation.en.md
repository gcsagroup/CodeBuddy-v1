# Builtin video generation

## Workflow source (updated 2026-10-26)

Images and videos read the configured ComfyUI server’s saved workflows directory. The Agent first calls inspect, then selects a returned saved:<path>.json ID based on user needs and structured parameters. Generation rereads the saved file instead of a bundled export. Unsaved browser edits are excluded. The original canvas is included as extra_data.extra_pnginfo.workflow; receipts identify the source path and content hash. Only requested prompts, seeds, references, output prefixes and supported explicit parameters are bound. Server files are never overwritten.

Only a complete catalog with no compatible workflow whose dependencies are available permits creation_allowed=true. Submission rechecks that condition. Listing/reading failures, unsupported formats, queueing, timeouts and execution errors never authorize replacement graphs. API graphs, named-widget saved graphs, subgraphs and basic reroutes are supported. Unsupported custom frontend serializers, repeated subgraph instances and bypass semantics report compatibility errors; save an API export or repair the workflow in ComfyUI. Installed dependencies do not prove model compatibility.

See the [official API format](https://github.com/Comfy-Org/docs/blob/main/development/api-development/workflow-api-format.mdx). The upstream frontend is GPL-3.0 and needs its browser runtime; its implementation was not copied or installed. This adapter converts persisted data with explicit compatibility boundaries.

Images and videos share the same approval interface: Deny Once, Allow Once, and Allow this tool for this session. A session grant covers only the corresponding tool and service in that conversation; image and video grants are independent. Later generation, status and cancellation calls for that service reuse the grant. Restarting the app, removing the tool, replacing its implementation or changing its service requires approval again. Explicit denial still takes precedence, and no global allow setting is saved.

Completed results return a local MP4 and an external playback link. Chat media cards play the local video in the current window’s right panel without requiring ComfyUI to remain online. External playback links require the service. Older receipts can still repair missing external links without regeneration.

Save the service URL in Settings → Models and runtime → Images and videos · ComfyUI. The Agent discovers generate_video and uses the existing conversation permissions and shared ComfyUI setting.

Text example: “Generate a 5-second video of a red panda waving beside a woodland stream, 640×384, with water and birdsong.” Image example: “Use workspace reference.png as the first frame of a 5-second animation.” Image input currently accepts workspace-local PNG; match output dimensions to its aspect ratio.

generate accepts text_to_video, image_to_video and reference_to_video. Omitted dimensions, duration and frame rate preserve server-saved defaults. Explicit dimensions must be multiples of 32, up to 1344×768 pixels; explicit duration is any finite positive number of seconds (including fractions) and requires a supported seconds parameter in the graph. CodeBuddy imposes no fixed duration cap on requests or completed MP4s. The Agent must preserve the requested duration; the saved graph retains its frame-grid rounding and frame rate. Actual node validation, model behavior, memory, disk and the existing 128 MiB download budget still apply. Unsupported duration binding or server rejection is reported, never silently shortened or replaced with another workflow.

The workflow uses installed MiniMax H3 FL2VA int8, Qwen3-VL 32B MiniMax int8, video fp16 VAE and audio fp32 VAE with native nodes and 20 base sampling steps. No automatic model download, third-party node installation or optional LoRA. Replacement servers must provide matching models and nodes.

Submit once, then poll status with the same job_id and wait_seconds up to 30. HTTP requests have a 300-second timeout. completed requires successful server execution, bounded MP4 structure/video-track metadata checks and a saved generated-videos/<job_id>/1.mp4. Receipts are session-scoped and retain their original server. Ambiguous submission is not automatically retried. cancel targets only that job, never a global interrupt. Stopping Agent polling does not itself cancel the GPU job.

Models and nodes come from the server-saved workflow. Existing Harness tool execution and session permissions are reused; no models or nodes are downloaded or installed.

## Preview media in chat and the right panel

Completed generation receipts show local image or video thumbnail cards in chat. Click **View in right panel** to preview images or play, pause and seek videos in the same window. Existing local media references in links, inline code or standalone code blocks also produce cards after verifying that the file exists inside the conversation workspace.

Previews read saved local files and do not require ComfyUI to remain online. Supported images: PNG, JPEG, GIF and WebP up to 32 MiB. Supported video containers: MP4, WebM and MOV up to 128 MiB; decoding depends on Electron codec support. During generation the tool status remains visible; complete video preview is available after the actual output has been saved. Missing, oversized or undecodable files report errors without changing the file.

The implementation reuses workspace checks and the existing right panel with an [Electron streaming protocol](https://www.electronjs.org/docs/latest/api/protocol/). It does not expose arbitrary filesystem paths or execute media content.
## Live generation and pet entry

Agent status receipts include transient, prompt-scoped `progress` (stage, node, step, total, connection and observation time); terminal receipts clear it. A sampling percentage describes that stage, not total completion. Background panel observation uses the same 300-second per-request download timeout as Agent status, and concurrent observers share one refresh. An uncertain submission is checked again after submission finishes, without creating another job; confirmed queued/running/completed state clears stale submission errors. Download failure leaves the job incomplete and can be retried against the same output without regenerating it.

Submitting image or video generation opens Generation in the right panel. Both use a local dotted animation with the current stage, step count and elapsed time, without intermediate preview frames. Percentages reflect service-reported stage progress, not overall completion; without step data the badge reads “Please wait.” Reconnecting never resubmits a job. Failure or cancellation stops the animation. After verified publication, the card switches to the final image or playable video. System reduced-motion preferences are respected.

New jobs submit `extra_data.preview_method: none` to disable standard ComfyUI intermediate preview computation while retaining WebSocket text progress and status queries. Binary preview frames from older jobs or custom nodes are discarded without encoding, caching or forwarding them to the UI. Previously submitted jobs are not reconfigured retroactively. Final decoding and output-saving nodes still execute normally. This uses [ComfyUI's preview implementation](https://github.com/Comfy-Org/ComfyUI/blob/v0.37.0/latent_preview.py).

Create a pet prepares a new-task template without allocating a conversation until Send. Pet descriptions are clamped to three lines with a full-text tooltip, and activation buttons align at the bottom.

[ComfyUI WebSocket protocol](https://docs.comfy.org/development/comfyui-server/comms_messages): existing native API reused; no third-party implementation copied, no additional dependencies.
