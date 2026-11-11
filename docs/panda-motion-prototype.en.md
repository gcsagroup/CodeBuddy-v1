# Natural red-panda motion prototype

> 2026-11-10: The user rejected the generated-parts/cutout visual approach. This document describes the rejected sample only. Its visual and performance results do not validate a subsequent whole-character animation. Do not integrate it into the production pet.

2026-11-10. Source: `D:\CodeBuddy-v1`, `main / b7865d54` plus uncommitted prototype changes. No branches, dependencies, commits, pushes or production pet replacement.

`ui/desktop/src/pets/prototype/` uses Canvas2D layered skeletal transforms, without the Spine SDK or mesh skinning. It implements idle, pointer observation, waving and jumping, including interruption and transitions. Blinking switches open/closed head drawings; independent pupils and continuous eyelids are not implemented.

From `ui/desktop`, run `node scripts/preview-panda-rig.cjs` for the local preview, or `node scripts/preview-panda-rig.cjs --export` for a self-contained offline `.local/panda-rig-review/panda-preview.html`. That folder also contains browser recordings, screenshots and performance JSON. The recording is 25 fps, independent of renderer frame rate.

Windows Edge, 1100×870 viewport, DPR 2, a 40-second run without recording: 320px for 15s averaged 56.25 fps; 160px for 10s averaged 56.38 fps; 160px with 4× CPU throttling for 15s averaged 56.30 fps. Maximum per-window draw P95 values were 0.30/0.30/1.60 ms; maximum frame-interval P95 was 18.6 ms. No frames exceeded 50 ms during these phases. A separate recorded interaction run had a few long frames. JS heap snapshots changed from approximately 2.39 to 1.96 MB, excluding total texture/GPU/browser memory. This short run does not prove absence of long-term leaks. Browser throttling is not separate low-end hardware.

Safeguards: decode/trim/cache layers once; no alpha scans or React updates in the draw loop; DPR capped at 2; time-based animation; pause scheduling while hidden; stop drawing in reduced motion; cancel RAF and listeners on disposal; retain at most 180 telemetry records.

Final checks exited 0: `corepack pnpm run test:run src/pets/prototype` (7 tests); both scenarios in `corepack pnpm exec playwright test tests/e2e/panda-rig.browser.spec.ts --reporter=list` passed separately (the second using `-g 'without recording'`); `corepack pnpm run typecheck`; `corepack pnpm exec eslint src/pets/prototype/*.ts --max-warnings 0`; targeted Prettier checks; offline export and browser load. Coverage includes jump clipping, interruption, gaze timing, reduced motion, visibility/resume, disposal and frame budgets. Node 22 differs from the declared Node 24; the environment was not changed.

Full Electron, cross-platform and extended-duration acceptance are pending. Production integration must test transparent windows, hit testing and overall resource consumption while preserving existing sprite packages. Automated checks are not user visual acceptance.

The built-in imagegen tool produced the layered art from the existing original panda reference. The prompt is in `assets/provenance.json`. Design references: [Spine](https://en.esotericsoftware.com/spine-weights), [Live2D](https://docs.live2d.com/en/cubism-editor-manual/about-fade/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas). No third-party art/code or commercial runtime was imported.
