# Desktop pets

Settings → Pets offers Red Panda, Cream Cat and White Fox. Red Panda is the default. Click a card to preview, then choose Set as desktop pet to select and show it. Show and Hide are also available separately. Existing custom selections are retained; the early `buddy` default migrates to `red-panda`.

Animations cover idle, wave, jump, working, waiting for input, blocked, review completed and gaze directions. Drag to move, click to greet and double-click to jump. Task notices consume structured ACP session state; clicking a notice opens its session. Reduce motion is available in settings.

A completion notice is marked read only when its chat is visible in a focused window. Requesting navigation does not clear it early. Hidden chats and background windows do not acknowledge it; a new completion can notify again. Removing a session also clears its pet notice.

One pet hosts an expandable chat list, prioritizing input needed, blocked, unread completed, then working chats. Each card shows its title and actual activity (thinking, responding, active tool, compaction, and so on), plus an existing structured work stage when available. Completed cards have a checkmark. A new unnamed chat uses its first request as a title. Clicking a card opens that exact chat. No percentages are invented, and completion is never inferred from reply text.

## Assets and creation

The completion checkmark and sidebar green unread dot consume the same completion record and clear together after the chat is viewed. When the Agent calls `ask_user_question`, the pet shows a waiting-for-reply notice and question summary. Clicking opens that question; viewing does not answer it. Pause uses the existing session stop action. Follow up opens the original chat so the user can send further instructions.

Create a pet starts a chat in the current window and prefills an editable template for character, name, colors, style, actions and other preferences. The user edits and sends it; prefilling neither invokes the model nor opens another window.

Bundled art works offline. The three characters use user-approved original concepts and consecutive poses generated with a ComfyUI Qwen Image 2.1 image-edit workflow. Web references informed the style; no third-party finished assets were copied.

Create a pet opens a real chat with the main CodeBuddy Agent. It asks for missing character, color, style and name preferences, then calls the builtin `create_desktop_pet` tool. `prepare` returns image requirements; `assemble` packs actual images, validates them and registers a preview package. New packages appear automatically in settings, with manual refresh also available. They become active only after the user previews and selects Set as desktop pet.

The main Agent orchestrates the workflow through the builtin `generate_image` tool and the configured ComfyUI service, generating a character reference followed by eight pose grids. The chat model interprets the request and writes prompts, ComfyUI generates pixels, and the assembly tool validates and registers the package. See [Builtin image generation](image-generation.en.md) for configuration, reference formats and job polling. Missing image capabilities must be explained instead of presenting duplicated static frames as newly generated animation.

The creation chat uses the custom asset directory shown in settings as its explicit workspace and prefills editable requirements. If an image tool is missing, users can provide an existing image service and workflow for the Agent to check and use. Service addresses, credentials and available models are not automatically inherited from Codex.

A custom package lives in the directory shown in settings, inside a folder named after its stable English ID, containing only `pet.json` and `sprites.png`. Reserved IDs: `buddy`, `red-panda`, `cream-cat`, `white-fox`.

The version 1 manifest uses `schemaVersion: 1`, `image: "sprites.png"`, `columns: 6`, `rows: 8`, `cellWidth: 192`, `cellHeight: 208`, `fps: 6`, plus `id`, `name` and `description`. The transparent RGBA PNG is 1152×1664. Rows follow the eight animations listed above. Gaze frames are up, upper-right, lower-right, down, lower-left and upper-left. Each cell needs at least a 2-pixel transparent margin and each animation at least three genuinely different drawn poses.

Invalid updates report errors and preserve the validated version. A damaged bundled package can fall back to another valid companion. No empty floating window opens when no valid art exists.

## Assembly

`runtime/assets/assemble-pet.py` crops, scales and registers generated poses, then exports previews and inspection records; it does not draw characters. The former `ui/desktop/scripts/assemble-pet.py` remains an entry point to the same implementation. The builtin tool accepts workspace-local images, validates a temporary package before publishing it atomically, preserves existing IDs and never selects the pet automatically. Pixel checks do not prove character consistency or action semantics; visual preview is still required. Source images, workflows and local acceptance files live under `target/pet-redesign` and are not distributed with the application.
