# Builtin video generation

Completed results return a local MP4 and an external playback link. Chat media cards play the local video in the current window’s right panel without requiring ComfyUI to remain online. External playback links require the service. Older receipts can still repair missing external links without regeneration.

Save the service URL in Settings → Models and runtime → Images and videos · ComfyUI. The Agent discovers generate_video and uses the existing conversation permissions and shared ComfyUI setting.

Text example: “Generate a 5-second video of a red panda waving beside a woodland stream, 640×384, with water and birdsong.” Image example: “Use workspace reference.png as the first frame of a 5-second animation.” Image input currently accepts workspace-local PNG; match output dimensions to its aspect ratio.

generate accepts mode=text_to_video or image_to_video; the latter requires image_path. Defaults are 640×640, 5 seconds and 24 fps. Dimensions must be multiples of 32, with at most 1344×768 pixels. Duration is 5–15 seconds, rounded up to the model's 17k+5 frame grid; requesting 5 seconds typically produces about 5.17 seconds.

The workflow uses installed MiniMax H3 FL2VA int8, Qwen3-VL 32B MiniMax int8, video fp16 VAE and audio fp32 VAE with native nodes and 20 base sampling steps. No automatic model download, third-party node installation or optional LoRA. Replacement servers must provide matching models and nodes.

Submit once, then poll status with the same job_id and wait_seconds up to 30. HTTP requests have a 300-second timeout. completed requires successful server execution, bounded MP4 structure/video-track metadata checks and a saved generated-videos/<job_id>/1.mp4. Receipts are session-scoped and retain their original server. Ambiguous submission is not automatically retried. cancel targets only that job, never a global interrupt. Stopping Agent polling does not itself cancel the GPU job.

The API graph is independently assembled from the [official H3 native workflow](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native) and installed node schemas. The official Harness question module uses MIT; model usage follows its own license. Model inventory and successful queue submission are not video acceptance.

## Preview media in chat and the right panel

Completed generation receipts show local image or video thumbnail cards in chat. Click **View in right panel** to preview images or play, pause and seek videos in the same window. Existing local media references in links, inline code or standalone code blocks also produce cards after verifying that the file exists inside the conversation workspace.

Previews read saved local files and do not require ComfyUI to remain online. Supported images: PNG, JPEG, GIF and WebP up to 32 MiB. Supported video containers: MP4, WebM and MOV up to 128 MiB; decoding depends on Electron codec support. During generation the tool status remains visible; complete video preview is available after the actual output has been saved. Missing, oversized or undecodable files report errors without changing the file.

The implementation reuses workspace checks and the existing right panel with an [Electron streaming protocol](https://www.electronjs.org/docs/latest/api/protocol/). It does not expose arbitrary filesystem paths or execute media content.
## Live generation and pet entry

Submitting generation opens Generation in the right panel, showing the current node, its step count, and the latest actual preview frame from the service. Node percentages are not overall video completion. Missing frames show a waiting state; reconnecting never resubmits a job. After verified publication, the same card switches to the playable local output.

Create a pet prepares a new-task template without allocating a conversation until Send. Pet descriptions are clamped to three lines with a full-text tooltip, and activation buttons align at the bottom.

[ComfyUI WebSocket protocol](https://docs.comfy.org/development/comfyui-server/comms_messages): existing native API reused; no third-party implementation copied, no additional dependencies.
