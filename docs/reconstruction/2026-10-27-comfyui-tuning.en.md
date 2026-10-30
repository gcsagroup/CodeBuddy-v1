# ComfyUI tuning, skill and background waiting

[简体](2026-10-27-comfyui-tuning.zh-CN.md) · [繁體](2026-10-27-comfyui-tuning.zh-TW.md)

Implemented in the existing dirty worktree at `D:\CodeBuddy-v1`, branch `main`, base revision `797b2b0acb12456a12a42a5dc9f3cf97ca2880c9`. Existing edits are preserved. This batch is uncommitted/unpushed, installs no dependencies, changes no saved server workflows and submits no GPU jobs.

## Behavior

The UI's “period” is seconds: supplied I2V/T2V defaults are 30 seconds, R2V is 5. The original graph converts seconds at 24 fps and aligns frames. Existing duration binding is preserved; this batch adds visibility and tuning.

Inspection now returns `duration_seconds` and `tunable_parameters`. `workflow_parameters` adjusts connected Turbo switches, full/turbo step counts, LoRA strength, sampler, scheduler, denoise, and applicable CFG/reference sizing controls. Types, ranges and choices come from current server schemas; duplicate or unknown IDs fail before submission. Models, files, expressions, links and fps are excluded from generic tuning. Submission rereads saved graphs and schemas; promoted UI widgets and executable graph values stay consistent.

Foreground waiting has a cumulative 240-second budget from job creation. If still queued/running, `waiting_in_background=true` directs the model to end the turn, explain that the result will appear in the right-side generation panel, and stop automatic polling. A user can request another immediate check. The existing panel continues observing and saving outputs; ComfyUI can run while the app is closed or another chat is selected, and returning to the original chat resumes observation.

History checks are shared by long waits and the sidebar: roughly every 30 seconds with WebSocket connected, or 10 seconds disconnected. Terminal events wake history verification; they do not establish completion. A slow download does not extend foreground waiting or resubmit generation. Omitted/zero wait_seconds retains a single immediate observation for compatibility.

A bundled `comfyui` skill in Simplified Chinese, Traditional Chinese and English uses the existing Harness registry, discovery and permissions. Loading guidance reveals only registered media tools and grants no execution permission. Changed modules: `runtime/comfyui-{saved-workflows,tool,video-tool,workflows,live}.mjs`, `runtime/harness/{comfyui-skill,profile,tool-discovery}.mjs`, `runtime/harness/skills/comfyui/SKILL*.md`. Regressions: `runtime/tests/comfyui-{saved-workflows,video-tool,skill}.test.mjs`. Existing receipt/publication ownership is unchanged.

## Selection rationale

Use [official WebSocket semantics](https://docs.comfy.org/development/comfyui-server/comms_messages) with a small CodeBuddy-specific guide. The [existing MiniMax skill](https://github.com/artokun/comfyui-mcp/blob/main/plugin/skills/minimax-h3-video/SKILL.md) belongs to an MIT project, not archived, last pushed October 26 when checked October 27. It depends on its own MCP tools, so direct installation would not fit CodeBuddy's interfaces. No external plugin or implementation was installed/copied.

## Validation and handoff

- Existing Node 24.22.1 ran `--test runtime/tests/comfyui-*.test.mjs runtime/tests/generated-image-observation.test.mjs runtime/harness/test/computer-skill.test.mjs`: 58/58, exit 0.
- `corepack pnpm --dir ui/desktop run test:run src/workspace-panel/WorkspaceGeneration.test.tsx src/workspace-panel/WorkspacePanel.test.tsx`: 38/38, exit 0. System Node 22.23.2 emitted an engine warning; environment unchanged.
- `corepack pnpm --dir ui/desktop exec playwright test generation-wait.browser.spec.ts --reporter=line --output=D:/CodeBuddy-v1/.local/comfyui-tuning/browser-results`: 2/2 in real Edge, exit 0, using controlled image/video fixtures with playback and narrow-viewport screenshot review.
- Three supplied API graphs and four live server UI graphs: seven read-only binding/recompilation checks passed; no generation submitted. `git diff --check`: exit 0.
- The Python skill validator exited 1 because yaml was absent. No dependency was installed. Existing JS YAML parsing validated all three frontmatters, and real Harness registration/loading tests passed.

The README's `start-preview.ps1` built SDK/language assets and Electron from this checkout; logs confirm React ready. The isolated data root is `.local/comfyui-tuning/preview`; the process remains running. This is a development preview, not an installer. Evidence resides under `.local/comfyui-tuning/`; fixtures/profiles are not committed.

Acceptance prompt: “Generate a 30-second video with the saved MiniMax T2V workflow and Turbo enabled. After 240 seconds, tell me it is still running in the background and show the finished result on the right.” Check one submission, bounded foreground waiting, panel completion and playback. Separately verify I2V/R2V reference identity and quality. Logs: `preview/logs/preview/`; use the app's existing conversation export.

Real model + GPU + desktop generation, visual quality, VRAM consumption and long-video success remain unverified. Implementation, automated validation and development-preview readiness are complete.

## Follow-up: open a new-chat draft when using a skill

The shared skill entry used `noAutoSubmit`, which still created a session. `SkillManager.tsx` now passes the existing `draftOnly` flag. `App.tsx` and `Hub.tsx` support ordinary-chat drafts; CodePro reuses its existing draft flow. Clicking only fills the command. Users can edit, select a project, or leave; sending creates the session and directory through the existing flow. Project skills retain their directory. Existing empty folders were preserved.

Regression coverage is in `App.test.tsx`, `CodeProHub.input.test.tsx`, `codepro/CodeProHub.test.tsx`, `skills/SkillManager.test.tsx`, and `tests/e2e/skill-draft.spec.ts`. Windows `fixtures.ts` now uses the documented `start-preview.ps1` entry, passing the current Node executable and Harness debugging port. No dependencies were installed.

`corepack pnpm --dir ui/desktop run test:run` with those four `src/` test paths initially passed 63/64; the only failure was a Windows path literal in the new test. After fixing it and adding an ordinary-route assertion, the two affected files passed 31/31 with exit 0; the other two had already passed. `corepack pnpm --dir ui/desktop run typecheck`, targeted ESLint, and `git diff --check` exited 0. The new E2E was formatted; pre-existing whole-file formatting differences in `CodeProHub.test.tsx` were left outside this fix.

Node 24 ran `../node_modules/@playwright/test/cli.js test skill-draft.spec.ts --reporter=line --output=D:/CodeBuddy-v1/.local/skill-draft/e2e-rerun` from `ui/desktop`: 1/1 passed, exit 0. In real Electron with an isolated profile, two consecutive skill selections created no directory; sending created exactly one. Both screenshots were reviewed. The initial fixture selected Node 22 and failed during startup; that is not a product behavior failure. Evidence is under `.local/skill-draft/`.

The passing ESLint scope is the listed `src/` files and the new E2E. An additional check of the shared `fixtures.ts` reported 16 existing rule errors; checking its HEAD content reproduced the same 16. These were left outside this fix.

Source: `main@797b2b0` plus the current uncommitted changes. No commit, push, or installer was produced. The skill-entry flow is verified; real GPU generation remains pending.

### Consistent skill draft text

The Toolbox action now reuses the composer's `composerMessages.useSkill`: “使用 comfyui 技能：” in Simplified/Traditional Chinese and “Use the comfyui skill to:” in English. Draft and directory selection behavior is preserved. `corepack pnpm --dir ui/desktop run test:run src/components/skills/SkillManager.test.tsx src/components/ChatInput.queue.test.tsx` passed 63/63, exit 0. Targeted ESLint, formatting and diff checks passed. Evidence prefix: `.local/skill-draft/unified-text-`.

Real Electron ran skill-draft.spec.ts and confirmed identical Toolbox and slash-menu text, no new directory before sending, and one afterward: 1/1 passed, exit 0. Screenshot reviewed; results are in unified-text-e2e/.
