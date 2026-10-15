# CodePro In-Place Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Retry action execute in the current ACP session instead of creating a `(copy)` session.

**Architecture:** Add an explicit `retry` message command that clones a valid source user request and submits it to the same `sessionId`. Then change the ordinary assistant-message action policy from `fork` to `resubmit`; structured checkpoint, linked replay, and validation retry paths remain unchanged.

**Tech Stack:** TypeScript, React, ACP desktop client, Vitest

## Global Constraints

- Retry must never call `acpForkSession` or navigate to a new session.
- A retried request receives a new message ID and preserves source image content.
- Explicit Duplicate Session and user-message Fork actions remain unchanged.
- No backend protocol change or new dependency is allowed.

---

### Task 1: Add the current-session retry command

**Files:**
- Modify: `ui/desktop/src/types/turnTerminal.ts:17`
- Modify: `ui/desktop/src/acp/chatSessionController.ts:330-410`
- Test: `ui/desktop/src/acp/__tests__/chatSessionController.test.ts:371-602`

**Interfaces:**
- Consumes: `updateMessage(sessionId, messageId, newContent, editType, options)` and an existing visible user `Message`.
- Produces: `MessageEditType` member `'retry'`; the controller appends a cloned request and calls `acpPromptSession(sessionId, clonedMessage)` without a retry-control payload.

- [ ] **Step 1: Write the failing controller test**

Add a test whose snapshot contains a visible user message with text and an image followed by an ordinary assistant message. Call:

```ts
await acpChatSessionController.updateMessage(
  SESSION_ID,
  source.id,
  'Fix the project',
  'retry' as never,
  { getCurrentSnapshot: () => currentSnapshot, onFinish: vi.fn() }
);
```

Assert that `setMessages` receives the existing messages plus a new user message with the original text and image, its ID differs from `source.id`, `acpPromptSession` receives `SESSION_ID`, and `acpForkSession` and `acpTruncateSessionConversation` are not called.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm.cmd test:run src/acp/__tests__/chatSessionController.test.ts
```

Expected: FAIL because `retry` is unsupported and the controller does not submit in place.

- [ ] **Step 3: Implement the minimal controller command**

Extend the union:

```ts
export type MessageEditType =
  | 'fork'
  | 'edit'
  | 'continue'
  | 'replay'
  | 'retry_validation'
  | 'retry';
```

Before the `fork` branch in `updateMessage`, validate that the selected message is a visible user message with text or images, create a fresh user message, append its source images, update the store, and call the existing `submitMessage` for the same session. Do not pass structured retry control because this is an ordinary new turn.

- [ ] **Step 4: Run the focused controller test and verify GREEN**

Run:

```powershell
pnpm.cmd test:run src/acp/__tests__/chatSessionController.test.ts
```

Expected: PASS, including the new same-session and no-fork assertions.

- [ ] **Step 5: Commit the controller increment**

```powershell
git add -- ui/desktop/src/types/turnTerminal.ts ui/desktop/src/acp/chatSessionController.ts ui/desktop/src/acp/__tests__/chatSessionController.test.ts
git commit -m "fix: retry messages in the current session"
```

### Task 2: Route the Retry button to the new command

**Files:**
- Modify: `ui/desktop/src/components/messageActionsModel.ts:7-48`
- Modify: `ui/desktop/src/components/GooseMessage.tsx:85-196`
- Test: `ui/desktop/src/components/messageActionsModel.test.ts:54-98`
- Test: `ui/desktop/src/components/GooseMessage.test.ts`

**Interfaces:**
- Consumes: `MessageEditType` member `'retry'` from Task 1.
- Produces: fallback `AssistantRetryMode` member `'resubmit'`; ordinary Retry invokes `onRetryMessage(sourceUserMessageId, sourceText, 'retry')`.

- [ ] **Step 1: Write failing policy and component tests**

Change the ordinary-final-answer policy expectation to:

```ts
expect(policy.retryMode).toBe('resubmit');
```

Add or update the GooseMessage retry-mode assertion so a message without a structured terminal returns `resubmit`, while `continue_checkpoint`, `retry_failed_validation`, `replay_user_request`, and `not_available` keep their existing results.

- [ ] **Step 2: Run the focused component tests and verify RED**

Run:

```powershell
pnpm.cmd test:run src/components/messageActionsModel.test.ts src/components/GooseMessage.test.ts
```

Expected: FAIL because the current fallback is `fork`.

- [ ] **Step 3: Implement the minimal UI routing change**

Replace the fallback `fork` retry mode with `resubmit`, and map it in `GooseMessage` to:

```ts
() =>
  onRetryMessage(
    retrySource.id!,
    getTextAndImageContent(retrySource).textContent,
    'retry'
  )
```

Keep the explicit user-message fork and Duplicate Session handlers untouched.

- [ ] **Step 4: Run focused tests, typecheck, and lint without fixes**

Run:

```powershell
pnpm.cmd test:run src/components/messageActionsModel.test.ts src/components/GooseMessage.test.ts src/acp/__tests__/chatSessionController.test.ts
pnpm.cmd typecheck
pnpm.cmd exec eslint src/components/messageActionsModel.ts src/components/GooseMessage.tsx src/types/turnTerminal.ts src/acp/chatSessionController.ts src/components/messageActionsModel.test.ts src/components/GooseMessage.test.ts src/acp/__tests__/chatSessionController.test.ts --max-warnings 0 --no-warn-ignored
```

Expected: all tests PASS, typecheck exits 0, and ESLint exits 0.

- [ ] **Step 5: Commit the UI routing increment**

```powershell
git add -- ui/desktop/src/components/messageActionsModel.ts ui/desktop/src/components/GooseMessage.tsx ui/desktop/src/components/messageActionsModel.test.ts ui/desktop/src/components/GooseMessage.test.ts
git commit -m "fix: keep Retry in the active conversation"
```

