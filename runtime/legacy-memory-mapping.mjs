import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Mirrors crates/goose/src/agents/platform_extensions/project_memory.rs:
// fs::canonicalize, slash normalization, Windows lowercase, BLAKE3 first 32 hex.
export function legacyMemoryIdentityInput(
  canonical,
  platform = process.platform,
) {
  const name =
    platform === "win32" ? path.win32.toNamespacedPath(canonical) : canonical;
  const normalized = name.replace(/\\/gu, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Candidate paths are read only from the original project index and session DB. */
export async function findLegacyMemoryMappings({ sourceDir, blake3 }) {
  if (typeof blake3 !== "function")
    throw new TypeError("A verified BLAKE3 implementation is required");
  const source = await realpath(sourceDir);
  const projects = JSON.parse(
    await readFile(path.join(source, "projects.json"), "utf8"),
  );
  const candidates = new Set(
    Object.values(projects.projects ?? {})
      .map((row) => row.path)
      .filter((value) => typeof value === "string"),
  );
  const database = new DatabaseSync(
    path.join(source, "sessions", "sessions.db"),
    { readOnly: true },
  );
  try {
    for (const row of database
      .prepare("SELECT DISTINCT working_dir FROM sessions")
      .all())
      if (typeof row.working_dir === "string") candidates.add(row.working_dir);
  } finally {
    database.close();
  }
  const canonicalPaths = new Map();
  const historicalPaths = new Map();
  let unavailableCandidates = 0;
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      unavailableCandidates++;
      continue;
    }
    const historical = {
      projectPath: path.resolve(candidate),
      reason: "canonical_identity_changed",
    };
    historicalPaths.set(
      legacyMemoryIdentityInput(historical.projectPath),
      historical,
    );
    try {
      const canonical = await realpath(candidate);
      if (!(await stat(canonical)).isDirectory()) {
        unavailableCandidates++;
        continue;
      }
      canonicalPaths.set(legacyMemoryIdentityInput(canonical), canonical);
    } catch (error) {
      historical.reason =
        error.code === "ENOENT"
          ? "historical_directory_missing"
          : "historical_directory_unavailable";
      unavailableCandidates++;
    }
  }
  const hashes = new Map();
  for (const [normalized, canonical] of canonicalPaths) {
    const digest = Buffer.from(
      blake3(new TextEncoder().encode(normalized)),
    ).toString("hex");
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new TypeError("BLAKE3 must produce a 32-byte digest");
    const identity = digest.slice(0, 32);
    hashes.set(identity, [...(hashes.get(identity) ?? []), canonical]);
  }
  const historicalHashes = new Map();
  for (const [normalized, historical] of historicalPaths) {
    const identity = Buffer.from(blake3(new TextEncoder().encode(normalized)))
      .toString("hex")
      .slice(0, 32);
    historicalHashes.set(identity, [
      ...(historicalHashes.get(identity) ?? []),
      historical,
    ]);
  }
  const matches = [],
    unresolved = [],
    projectMap = {};
  for (const entry of await readdir(path.join(source, "memory"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/u.test(entry.name)) continue;
    let document;
    try {
      document = JSON.parse(
        await readFile(
          path.join(source, "memory", entry.name, "memory.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      document.project_identity !== entry.name ||
      !Array.isArray(document.entries)
    )
      throw new Error("Legacy memory identity does not match its directory");
    const paths = hashes.get(entry.name) ?? [];
    const row = {
      sourceIdentity: entry.name,
      records: document.entries.length,
    };
    if (paths.length === 1) {
      projectMap[entry.name] = paths[0];
      matches.push({ ...row, projectPath: paths[0] });
    } else {
      const historic = historicalHashes.get(entry.name) ?? [];
      unresolved.push({
        ...row,
        ...(paths.length
          ? { reason: "ambiguous_canonical_path" }
          : historic.length === 1
            ? { ...historic[0], historicalIdentityMatched: true }
            : { reason: "no_existing_canonical_match" }),
      });
    }
  }
  return {
    version: 1,
    source,
    rule: "Rust canonical path with Windows namespace prefix, slash normalization and lowercase; BLAKE3 first 32 hex",
    candidatePaths: candidates.size,
    existingCanonicalPaths: canonicalPaths.size,
    unavailableCandidates,
    matches,
    unresolved,
    projectMap,
  };
}
