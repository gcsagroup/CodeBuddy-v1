# Builtin video generation

Completed results include a local MP4 path and a clickable browser playback link to the ComfyUI output. The link requires that service to remain online; the local file can be retained and played independently. Video is not embedded as an image. Querying an older receipt repairs its missing playback link without regenerating the video.

Save the service URL in Settings → Models and runtime → Images and videos · ComfyUI. The Agent discovers generate_video and uses the existing conversation permissions and shared ComfyUI setting.

Text example: “Generate a 5-second video of a red panda waving beside a woodland stream, 640×384, with water and birdsong.” Image example: “Use workspace reference.png as the first frame of a 5-second animation.” Image input currently accepts workspace-local PNG; match output dimensions to its aspect ratio.

generate accepts mode=text_to_video or image_to_video; the latter requires image_path. Defaults are 640×640, 5 seconds and 24 fps. Dimensions must be multiples of 32, with at most 1344×768 pixels. Duration is 5–15 seconds, rounded up to the model's 17k+5 frame grid; requesting 5 seconds typically produces about 5.17 seconds.

The workflow uses installed MiniMax H3 FL2VA int8, Qwen3-VL 32B MiniMax int8, video fp16 VAE and audio fp32 VAE with native nodes and 20 base sampling steps. No automatic model download, third-party node installation or optional LoRA. Replacement servers must provide matching models and nodes.

Submit once, then poll status with the same job_id and wait_seconds up to 30. HTTP requests have a 300-second timeout. completed requires successful server execution, bounded MP4 structure/video-track metadata checks and a saved generated-videos/<job_id>/1.mp4. Receipts are session-scoped and retain their original server. Ambiguous submission is not automatically retried. cancel targets only that job, never a global interrupt. Stopping Agent polling does not itself cancel the GPU job.

The API graph is independently assembled from the [official H3 native workflow](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native) and installed node schemas. The official Harness question module uses MIT; model usage follows its own license. Model inventory and successful queue submission are not video acceptance.
