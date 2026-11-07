# Modes, tuning and diagnosis

Live tool schemas take precedence. These are CodeBuddy arguments, not raw HTTP payloads.

| Intent | Tool / inspect.mode | Generation references |
| --- | --- | --- |
| Text image | generate_image / text_to_image | Omit reference_images |
| Edit image | generate_image / image_to_image | 1–2 reference_images; pass the same array to inspect |
| Text video | generate_video / text_to_video | Omit both reference fields |
| Animate first frame | generate_video / image_to_video | One image_path |
| Identity/object reference | generate_video / reference_to_video | 1–2 reference_images |

Image generation derives its mode from reference_images. Video generation requires mode. Do not mix reference fields. R2V is not first/last-frame interpolation. The interface has no last_frame, audio-reference or video-reference argument; model capability does not add tool fields. Inputs must be regular workspace PNGs, ≤20 MiB and ≤16,777,216 pixels each. Resolved paths must remain inside the workspace.

## Calls and tuning

[requests.json](requests.json) has one example per mode. Select only the relevant one. The current-request interpreter selects the workflow; omit `workflow_name`. Substitute inspected workspace paths for `$image_1`/`$image_2`. Rewrite the sample prompt for the actual user. Never submit placeholders or execute the whole set. Omit request_id for a host-generated UUID; retain the returned job_id and use the same tool for status/cancel.

- Explain preserved and edited features. No mask argument is available, so do not guarantee pixel-exact local editing. Requested transparency does not establish alpha.
- Omit both dimensions to preserve defaults; supply both to override, avoiding the omitted side defaulting to 1024. Image sides: 256–2048. Video sides: 256–1344, total pixels ≤1344×768. All sides must be multiples of 32. Binding also requires a unique ResolutionSelector and a supported ratio.
- 1024×576 and 576×1024 satisfy numeric and aspect-ratio requirements, subject to graph binding. The native 1344×768 default is not strict 16:9: do not mechanically pass it back as an override. Omit dimensions to preserve the native default; report actual output dimensions.
- duration_seconds is seconds, including fractions. Preserve the graph's frame conversion/fps. Missing a unique seconds input is a binding limitation, not permission to change formulas or shorten the request.
- Fix seed for comparisons; omission randomizes it. Within an authorized iteration, vary one effective control at a time and record workflow.id/sha256, inputs and output paths.
- For each tunable_parameter read parameter, current, every constraint and every binding. All constraints must hold; retain number/boolean/enum types. At most 32 distinct IDs; omitted controls preserve defaults. IDs are not portable between graphs.
- Locate steps by bindings.input, then the branch. A branch_switch is boolean: true selects on_true, false selects on_false. Check all consumers. Do not infer Turbo from a label, screen position or fixed node ID.
- Preserve coherent model/LoRA/sampling settings for Turbo. Use live allowed strength, CFG, denoise, sampler, scheduler and ref_image_size values. More CFG/steps is not guaranteed improvement; ordinary SD negative-prompt habits do not apply to an H3 graph without that branch.
- Override shape: `workflow_parameters:[{"parameter":"ID from current inspect","value":true}]`. Choose a meaningful value, not the literal illustrative value. Do not add undeclared top-level steps/turbo_mode fields.

## Diagnose by evidence

| Evidence | Action |
| --- | --- |
| Connection/permission error | Report it and use existing app settings; no host scanning, credential changes or client installation. |
| missing/blockers | Name workflow and specific requirements; do not invent graphs, install dependencies or replace models. |
| Invalid ID/enum/ratio/duration binding | Re-inspect the chosen graph and correct unsubmitted inputs. Explain unsupported requirements without substituting the goal. |
| Uncertain submission/observation | At most one recovery check on the original ID, then report uncertainty; never probe with repeat generate calls. |
| GPU OOM | Offer a grounded adjustment; do not shorten explicitly requested duration, restart or globally unload models automatically. |
| Disk/download error or empty output | Preserve receipts/files and address delivery. Do not regenerate or claim success. |
| Unconfirmed cancellation | Report it. If per-job cancellation is unavailable, use ComfyUI manually, not global interrupt. |
| Missing/cross-session job | Return to its original conversation; do not scan IDs or edit receipts. |

## Conditional creation

Consider fallback only when current inspect says creation_allowed=true. Request needed schemas with node_types (≤24); paginate with node_offset/next_node_offset. Do not flood context with all nodes. An API graph is distinct from UI nodes/links. Use installed class_type/model enums and valid links, `$prompt`, `$reference:0`/`$reference:1` in LoadImage.image, and `$width`/`$height`/`$seed`/`$duration_seconds` for explicitly supplied inputs. Use one final PNG/MP4 save node. The host rechecks eligibility and graph validity. Do not combine workflow_parameters with fallback, install/download dependencies or restart services to expand scope.

Authority: current `runtime/comfyui-*.mjs`; [official routes](https://docs.comfy.org/development/comfyui-server/comms_routes) explain the underlying protocol, still accessed through host tools.
