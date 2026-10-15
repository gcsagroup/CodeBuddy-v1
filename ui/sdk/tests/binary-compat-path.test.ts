import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("binary compatibility check resolves the SDK root on Windows", () => {
  const script = fileURLToPath(
    new URL("../scripts/check-binary-compat.mjs", import.meta.url),
  );
  const env = { ...process.env };
  delete env.GOOSE_BINARY;

  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /GOOSE_BINARY must point to a built goose binary/,
  );
  assert.doesNotMatch(result.stderr, /expected built SDK/);
});

test("binary compatibility check imports the built SDK on Windows", () => {
  const script = fileURLToPath(
    new URL("../scripts/check-binary-compat.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GOOSE_BINARY: script },
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /ERR_UNSUPPORTED_ESM_URL_SCHEME/);
});
