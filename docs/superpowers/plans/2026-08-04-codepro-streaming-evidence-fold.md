# CodePro Streaming Evidence Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent raw `<details>` and `<summary>` tags from appearing while a CodePro technical-evidence block is still streaming.

**Architecture:** Extend the existing trusted CodePro evidence segment parser with one bounded partial-tail state. Keep rendering in `MarkdownContent` and preserve the existing HTML security boundary for all non-CodePro content.

**Tech Stack:** React 18, TypeScript, react-markdown, Vitest, Testing Library.

## Global Constraints

- Do not enable arbitrary raw HTML rendering.
- Only a trailing partial block inside a CodePro report may enter the streaming evidence state.
- Completed evidence blocks retain the existing native `<details>` behavior.

---

### Task 1: Parse and render partial CodePro evidence safely

**Files:**
- Modify: `ui/desktop/src/components/MarkdownContent.tsx`
- Test: `ui/desktop/src/components/MarkdownContent.test.tsx`

**Interfaces:**
- Consumes: `splitCodeProTechnicalEvidence(content: string)` and the existing `MarkdownSegment` union.
- Produces: a streaming technical-evidence segment that never exposes incomplete host tags.

- [ ] **Step 1: Write failing regression tests**

Add component tests for a CodePro report ending in `<details>`, an incomplete `<summary>`, and evidence text without `</details>`. Assert that raw tags are absent and “正在整理技术证据…” is visible. Add a non-CodePro control case.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm.cmd exec vitest run src/components/MarkdownContent.test.tsx`

Expected: the new streaming cases fail because the current exact regex requires `</details>`.

- [ ] **Step 3: Implement the minimal partial-tail state**

Add `streaming: true` to the technical-evidence segment variant, detect only a trailing partial block in a `# CodePro` report, and render a status row with `role="status"` and `aria-live="polite"`. Do not render partial evidence content.

- [ ] **Step 4: Run focused and broader verification**

Run:

```powershell
pnpm.cmd exec vitest run src/components/MarkdownContent.test.tsx
pnpm.cmd run typecheck
pnpm.cmd exec prettier --check src/components/MarkdownContent.tsx src/components/MarkdownContent.test.tsx
```

Expected: all commands exit 0.

- [ ] **Step 5: Verify the running Electron DOM**

Submit a CodePro analysis request and inspect the current renderer. During and after streaming, no leaf text node may equal `<details>`, `<summary>…</summary>`, or `</details>`; the completed block must be a native `DETAILS` element.
