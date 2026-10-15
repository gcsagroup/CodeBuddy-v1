import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const source = "D:/Users/jiangrui/Desktop/CodeBuddy";
const target = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(
  target,
  "docs/reconstruction/source-baseline.json",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const allowed = new Set([
  "ui/desktop/src/main.ts",
  "ui/desktop/src/gooseServe.ts",
  "ui/desktop/src/preload.ts",
  "ui/desktop/forge.config.ts",
  "ui/desktop/package.json",
  "package.json",
]);
if (process.argv.includes("--verify")) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const failures = [];
  let frozen = 0;
  for (const f of manifest.files.filter(
    (f) => f.path.startsWith("ui/") && !allowed.has(f.path),
  )) {
    try {
      if (digest(await readFile(path.join(target, f.path))) !== f.sha256)
        failures.push(f.path);
    } catch {
      failures.push(f.path);
    }
    frozen++;
  }
  console.log(JSON.stringify({ frozenFiles: frozen, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} else {
  const git = (args) =>
    execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  const names = [
    ...new Set(
      git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const files = [];
  const excluded = [];
  for (const name of names) {
    if (
      /(^|\/)(node_modules|target|\.git|\.vite|\.venv|out)(\/|$)/.test(name) ||
      /(^|\/)(\.env|secrets\.yaml)$/.test(name)
    ) {
      excluded.push(name);
      continue;
    }
    const src = path.resolve(source, name),
      dst = path.resolve(target, name);
    if (
      !src.startsWith(path.resolve(source) + path.sep) ||
      !dst.startsWith(target + path.sep)
    )
      throw Error("Path outside baseline roots");
    let s;
    try {
      s = await stat(src);
    } catch (e) {
      if (e.code === "ENOENT") {
        excluded.push(name);
        continue;
      }
      throw e;
    }
    if (!s.isFile()) {
      excluded.push(name);
      continue;
    }
    const bytes = await readFile(src);
    const sha256 = digest(bytes);
    await mkdir(path.dirname(dst), { recursive: true });
    let existing;
    try {
      existing = await readFile(dst);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (existing && digest(existing) !== sha256)
      throw Error("Refusing to overwrite different destination: " + name);
    if (!existing) await copyFile(src, dst);
    if (digest(await readFile(src)) !== sha256)
      throw Error("Source changed during copy: " + name);
    files.push({ path: name, bytes: bytes.length, sha256 });
  }
  const manifest = {
    source,
    target,
    createdAt: new Date().toISOString(),
    head: git(["rev-parse", "HEAD"]).trim(),
    status: git(["status", "--porcelain=v1"]),
    files,
    excluded,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    JSON.stringify({
      copiedFiles: files.length,
      totalBytes: files.reduce((n, f) => n + f.bytes, 0),
      excluded: excluded.length,
      manifestPath,
    }),
  );
}
