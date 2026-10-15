# CodeBuddy Navigation Header Slot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the sidebar toggle from overlapping “New Chat” when unified CodePro mode hides the workspace switcher.

**Architecture:** Extract the existing sidebar header markup into a focused `NavigationHeaderSlot` component. The component always renders the 48px structural slot and conditionally renders only the workspace switcher content.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest, React Testing Library.

## Global Constraints

- Keep the existing 48px header height and design-system classes.
- Do not move the application-level navigation toggle.
- Do not change navigation items, session behavior, or task-panel layout.
- Preserve the existing workspace switcher behavior outside unified mode.

---

### Task 1: Persistent navigation header slot

**Files:**
- Create: `ui/desktop/src/components/Layout/NavigationPanel.test.tsx`
- Modify: `ui/desktop/src/components/Layout/NavigationPanel.tsx`

**Interfaces:**
- Consumes: `WorkspaceMode`, `WorkspaceSwitcher`, `unifiedMode`, and `onWorkspaceModeChange`.
- Produces: `NavigationHeaderSlot` with props `{ workspaceMode, onWorkspaceModeChange, unifiedMode }`.

- [ ] **Step 1: Write the failing component tests**

Test that unified mode retains a `data-testid="navigation-header-slot"` element with `min-h-[48px]` while hiding the workspace switcher. Test that normal mode retains the same slot and shows the switcher.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm.cmd exec vitest run src/components/Layout/NavigationPanel.test.tsx`

Expected: FAIL because `NavigationHeaderSlot` is not exported.

- [ ] **Step 3: Implement the minimal component**

Move the current header container into `NavigationHeaderSlot`, render the container unconditionally, and conditionally render `WorkspaceSwitcher` inside it.

- [ ] **Step 4: Use the component in Navigation**

Replace the conditional header block with one unconditional `NavigationHeaderSlot` invocation.

- [ ] **Step 5: Verify GREEN and regressions**

Run focused NavigationPanel and WorkspaceSwitcher tests, then `pnpm.cmd run typecheck` and Prettier check for the two changed TypeScript files.

- [ ] **Step 6: Check the patch**

Run `git diff --check` for the implementation files and confirm no unrelated files are included.
