# CodeBuddy Root pnpm Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented desktop pnpm commands work when invoked from `D:\CodeBuddy`.

**Architecture:** Add a private root manifest that acts only as a command proxy. It delegates dependency installation to the existing `ui` workspace and desktop startup to `ui/desktop`, leaving the existing workspace and lock file in place.

**Tech Stack:** pnpm 11, Node.js built-in test runner, JSON package scripts.

## Global Constraints

- Do not move `ui/pnpm-workspace.yaml` or `ui/pnpm-lock.yaml`.
- Do not modify Electron or Rust startup behavior.
- Preserve startup from `ui/desktop` and existing `just` recipes.
- Do not launch the long-running Electron process during automated verification.

---

### Task 1: Root command proxy

**Files:**
- Create: `scripts/root-pnpm-launcher.test.cjs`
- Create: `package.json`

**Interfaces:**
- Consumes: existing `ui/pnpm-workspace.yaml` and `ui/desktop/package.json` scripts.
- Produces: root scripts `install:ui`, `start-gui`, `start-gui-debug`, and `test:root-launcher`.

- [ ] **Step 1: Write the failing test**

Create a Node test that reads the root manifest and verifies that it is private and delegates commands to `ui` and `ui/desktop`:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('root pnpm scripts delegate to the existing UI workspace', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(manifest.private, true);
  assert.match(manifest.scripts['install:ui'], /--dir ui install --frozen-lockfile/);
  assert.match(manifest.scripts['start-gui'], /--dir ui\/desktop run start-gui$/);
  assert.match(manifest.scripts['start-gui-debug'], /--dir ui\/desktop run start-gui-debug$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/root-pnpm-launcher.test.cjs`

Expected: FAIL because `D:\CodeBuddy\package.json` does not exist.

- [ ] **Step 3: Add the minimal root manifest**

```json
{
  "name": "codebuddy-workspace-launcher",
  "private": true,
  "scripts": {
    "install:ui": "pnpm --dir ui install --frozen-lockfile",
    "prestart-gui": "pnpm run install:ui",
    "start-gui": "pnpm --dir ui/desktop run start-gui",
    "prestart-gui-debug": "pnpm run install:ui",
    "start-gui-debug": "pnpm --dir ui/desktop run start-gui-debug",
    "test:root-launcher": "node --test scripts/root-pnpm-launcher.test.cjs"
  }
}
```

- [ ] **Step 4: Run focused verification**

Run: `node --test scripts/root-pnpm-launcher.test.cjs`

Expected: PASS.

Run: `pnpm run`

Expected: lists `start-gui` and `start-gui-debug` without `ERR_PNPM_NO_PKG_MANIFEST`.

Run: `pnpm run test:root-launcher`

Expected: PASS through the same root entry point users invoke.

- [ ] **Step 5: Check the patch**

Run: `git diff --check -- package.json scripts/root-pnpm-launcher.test.cjs`

Expected: exit code 0.
