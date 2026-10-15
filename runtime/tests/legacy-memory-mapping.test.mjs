import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  legacyMemoryIdentityInput,
  findLegacyMemoryMappings,
} from "../legacy-memory-mapping.mjs";

test("legacy identity formatting preserves the exact Rust Windows namespace and UNC semantics", () => {
  assert.equal(
    legacyMemoryIdentityInput("D:\\CodeBuddy", "win32"),
    "//?/d:/codebuddy",
  );
  assert.equal(
    legacyMemoryIdentityInput("\\\\?\\D:\\CodeBuddy", "win32"),
    "//?/d:/codebuddy",
  );
  assert.equal(
    legacyMemoryIdentityInput("\\\\server\\Share\\Project", "win32"),
    "//?/unc/server/share/project",
  );
  assert.equal(
    legacyMemoryIdentityInput("/Users/Owner/Project", "darwin"),
    "/Users/Owner/Project",
  );
});

test("mapping uses only existing canonical candidates and leaves unmatched memories archived", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-memory-map-")),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codebuddy-memory-map-"));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  await mkdir(project);
  await mkdir(path.join(root, "sessions"));
  await mkdir(path.join(root, "memory"));
  await writeFile(
    path.join(root, "projects.json"),
    JSON.stringify({
      projects: {
        known: { path: project },
        gone: { path: path.join(root, "gone") },
      },
    }),
  );
  const db = new DatabaseSync(path.join(root, "sessions", "sessions.db"));
  db.exec("CREATE TABLE sessions(working_dir TEXT)");
  db.prepare("INSERT INTO sessions VALUES(?)").run(project);
  db.close();
  // The discovery algorithm receives an injected digest. Real BLAKE3 vectors
  // and the original profile are verified separately by the pinned tool run.
  const digest = (bytes) => createHash("sha256").update(bytes).digest();
  const matched = digest(
    Buffer.from(legacyMemoryIdentityInput(await realpath(project))),
  )
    .toString("hex")
    .slice(0, 32);
  const missing = digest(
    Buffer.from(legacyMemoryIdentityInput(path.join(root, "gone"))),
  )
    .toString("hex")
    .slice(0, 32);
  for (const id of [matched, missing, "f".repeat(32)]) {
    await mkdir(path.join(root, "memory", id));
    await writeFile(
      path.join(root, "memory", id, "memory.json"),
      JSON.stringify({
        project_identity: id,
        entries: [{ content: "Private text must not appear in report" }],
      }),
    );
  }
  const result = await findLegacyMemoryMappings({
    sourceDir: root,
    blake3: digest,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].projectPath, await realpath(project));
  assert.equal(result.matches[0].records, 1);
  assert.equal(result.unresolved.length, 2);
  assert.ok(
    result.unresolved.some(
      (row) => row.reason === "no_existing_canonical_match",
    ),
  );
  assert.equal(
    result.unresolved.find((row) => row.sourceIdentity === missing).reason,
    "historical_directory_missing",
  );
  assert.equal(
    result.unresolved.find((row) => row.sourceIdentity === missing)
      .historicalIdentityMatched,
    true,
  );
  assert.equal(Object.keys(result.projectMap).length, 1);
  assert.equal(result.unavailableCandidates, 1);
  assert.ok(!JSON.stringify(result).includes("Private text"));
});
