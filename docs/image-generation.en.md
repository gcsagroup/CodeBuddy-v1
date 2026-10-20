# Builtin image generation

The main Agent calls `generate_image` to create ordinary images, transparent artwork and reference edits through ComfyUI. The chat model interprets the request and writes prompts; the ComfyUI workflow generates pixels.

Configure the URL in Settings → Models and runtime → Images & video · ComfyUI. The current default is the user-supplied `http://192.168.9.111:8188`. The adapter uses the installed Qwen Image 2.1 workflow. Other endpoints need matching models and nodes: Qwen Image 2.1 int8, Qwen3-VL 8B int8 encoder, Qwen Image 2.1 VAE, `TextEncodeQwenImage21` and `SaveImageAdvanced`. Missing dependencies produce actual service errors; no automatic model or node installation occurs.

Ask the Agent for an image. Tool discovery uses `search_mcp_tools` and existing Harness permissions. `generate` submits once and returns a job ID; `status` waits up to 30 seconds and can be called again for the same ID. Individual HTTP requests have a 300-second timeout. Completion requires both successful server execution and saved output files.

Each request produces one PNG, with width and height 256–2048 in multiples of 32, and accepts up to two workspace-local PNG references. Outputs go to `generated-images/<job_id>/`. Session-owned receipts survive tool recreation and keep the original server address after configuration changes. An optional UUID `request_id` prevents duplicate submission on retries. Unknown submission outcomes preserve receipts and never trigger automatic resubmission.

`cancel` uses per-job cancellation and verifies state. Older servers without that endpoint return an explicit limitation; global interruption is never sent. Stopping chat polling does not cancel a remote GPU job; cancellation must target its job ID.

Custom pets reuse this image tool, then `create_desktop_pet` assembles eight animation states and registers a preview without switching the selected companion. Transparency, character consistency and animation quality still need visual review.

Video shares the same service configuration. The builtin `generate_video` tool uses MiniMax H3 for text-to-video and PNG first-frame image-to-video. See [Builtin video generation](video-generation.en.md) for parameters, required models and job polling.

Design reference: [official ComfyUI API](https://docs.comfy.org/development/comfyui-server/comms_routes). ComfyUI owns queue, execution and history facts; the adapter stores receipts and output files, without introducing another Agent scheduler. The client is independently implemented against the API; server implementation code is not copied.
