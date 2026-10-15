import assert from "node:assert/strict";
import test from "node:test";
import {
  zGooseSessionUpdate,
  type GooseSessionUpdate,
  type TestExecutionProgress,
} from "../src/index.ts";

const progress = {
  schemaVersion: 1,
  sessionId: "session-1",
  runId: "run-1",
  taskId: "tester-1",
  attemptId: "tester-1:1",
  phase: "waiting_for_cargo_lock",
  outcome: "locked",
  command: "cargo test --manifest-path D:\\project\\Cargo.toml --jobs 1",
  cwd: "D:\\project",
  elapsedMs: 4_000,
  heartbeatAt: "2026-08-26T08:00:04Z",
  retryAttempt: 0,
  repairAttempt: 0,
  canCancel: true,
} satisfies TestExecutionProgress;

test("generated SDK validates the typed test execution progress variant", () => {
  const update = {
    sessionUpdate: "test_execution_progress",
    progress,
  } satisfies GooseSessionUpdate;

  assert.deepEqual(zGooseSessionUpdate.parse(update), update);
});

test("generated SDK rejects display-string states and unsupported phases", () => {
  assert.equal(
    zGooseSessionUpdate.safeParse({
      sessionUpdate: "test_execution_progress",
      progress: { ...progress, phase: "测试失败了" },
    }).success,
    false,
  );
});
