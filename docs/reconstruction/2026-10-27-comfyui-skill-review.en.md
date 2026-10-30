# ComfyUI skill review and improvements

2026-10-27. Source: `D:\CodeBuddy-v1`, `main@797b2b0` plus uncommitted changes. Scope: existing guidance, references and contract tests. No public tool protocol, connection, permission or job ownership changes; no third-party skill/dependency installation, commit, push or installer.

## Comparison

- [Official Comfy CLI skill](https://github.com/Comfy-Org/comfy-cli/blob/main/comfy_cli/skills/comfy/SKILL.md): GitHub API reported GPL-3.0, not archived, last push 2026-10-27. Adopt discovery/execution separation and live-schema authority. Do not import CLI, cloud routing, installation or deployment behavior; implementation was not copied.
- [Portable Toolkit](https://github.com/Zambav/ComfyUI-Agent-Toolkit/blob/main/SKILL.md): MIT, not archived, last push 2026-06-04. Adopt on-demand references and environment discovery; exclude training, cron and another API client. Unarchived is not proof of quality or ongoing maintenance.
- [ComfyUI Expert API](https://github.com/MCKRUZ/ComfyUI-Expert/blob/master/skills/comfyui-api/SKILL.md): MIT, archived, last push 2026-03-18. Reject its five-second unbounded generation polling and global interruption suggestions. Preserve 240-second background handoff and scoped cancellation.
- Cross-check official [routes](https://docs.comfy.org/development/comfyui-server/comms_routes) and [events](https://docs.comfy.org/development/comfyui-server/comms_messages); host receipts remain authoritative.
- Use [H3 prompting](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide) and MiniMax [base](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)/[reference](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) guides only for the tool-supported subset.

Repository status/licensing was checked on the stated date and may change. These are design references, not imported runtime dependencies.

## Changes

Three language variants under `runtime/harness/skills/comfyui/` now cover task scope, asset inspection, bounded recovery, on-demand reading and delivery evidence. Unconditional preview rendering advice was removed. `references/operations*` covers five modes, slots, dimension ratios, seconds, Turbo/constraints and failures. `references/minimax-h3*` covers base/reference prompt structures. `requests.json` holds five substitution examples, not an automatic batch. `runtime/tests/comfyui-skill.test.mjs` verifies native reference reading and all examples through actual tool binding/upload/submission code against a controlled HTTP fixture.

Guidance does not expand tools: explicit dimensions still depend on ResolutionSelector/ratio binding, and model capability is not interface capability.

## Validation and limits

Existing Node 24.22.1 ran `node --test runtime/tests/comfyui-skill.test.mjs runtime/tests/comfyui-saved-workflows.test.mjs runtime/tests/comfyui-video-tool.test.mjs`: 37/37, exit 0. After refining the I2V opening, the skill suite passed 8/8, exit 0. Coverage includes permission boundaries, long durations, 240-second handoff, recovery and background publication. Isolated fixtures consumed no real GPU resources.

Existing JS YAML validated three frontmatters and local links across nine Markdown files. Diff checking passed. Existing recursive skill staging includes references by static inspection; no installer was built. No UI logic changed, so desktop rebuilding was not repeated. Logs: `.local/skill-draft/skill-upgrade-tests.log` and `skill-upgrade-examples-final.log`. New chats load current guidance; chats already holding the old skill should reload it.

Scripted model responses and HTTP fixtures establish contracts, not real-model adherence or GPU quality. Real acceptance remains pending for requested 30-second duration, I2V/R2V identity, correct Turbo branch, post-240-second panel delivery, and no duplicate submission after disconnection/OOM.

[简体](2026-10-27-comfyui-skill-review.zh-CN.md) · [繁體](2026-10-27-comfyui-skill-review.zh-TW.md)

## Real 20-second generation follow-up

The desktop model selected 20 seconds, 512×288 and Turbo 8 steps, but the request was rejected before ComfyUI submission. The `type` array in `workflow_parameters[].value` is outside the Harness validator's supported subset and produced a misleading `must be a lossless JSON value` error. Three equivalent scalar `oneOf` branches fix compatibility without changing values, job ownership or submission logic. A native Harness regression verifies unchanged boolean, number and string dispatch, while rejecting arrays, objects and null before dispatch.

The same three-file test command passed 38/38, exit code 0; `git diff --check` passed. The same isolated profile was restarted using `start-preview.ps1` to continue the real request. Video results are recorded separately; automated tests do not establish GPU acceptance.

Desktop session `0072aa1b-9ea1-4852-b6d8-cb9f472013f3` submitted one job, `32e161cf-b88f-4561-aade-d1191dc09ca4`, at 13:05:49 Asia/Shanghai. The server queue confirmed duration 20, 16:9 / 0.140625 MP / alignment 32, and Turbo=true / 8 steps. The model made one `status(wait_seconds=240)` call and ended its reply after `waiting_in_background=true`; the panel continued to 5/8 sampling steps, 63%. Real parameter delivery, single submission and background handoff passed. The video was still running when recorded; final MP4 duration, playback and quality remain unverified. The model did not read the additional references, so submission success does not establish full skill adherence.
