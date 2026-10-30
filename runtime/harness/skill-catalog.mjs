import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  readFile,
  readdir,
  stat,
  realpath,
  mkdir,
  writeFile,
  rename,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const key = (value) =>
  process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const absent = (error) => ["ENOENT", "ENOTDIR"].includes(error.code);

// One catalog supplies both Harness candidates and the toolbox inventory. Shared
// files remain owned by their installer; CodeBuddy stores only invocation choices.
export class SkillCatalog {
  constructor(ctx, control, config) {
    this.name = "filesystem";
    this.control = control;
    this.config = config;
    this.sharedRoot = resolve(
      config.sharedSkillDir ?? join(homedir(), ".agents", "skills"),
    );
    this.policyFile = join(config.dshHome, "shared-skills.json");
    this.cache = new Map();
    this.tail = Promise.resolve();
    this.messages = [];
    const metadataContext = {
      get: () => undefined,
      logger: { warn: (message) => this.messages.push(message) },
    };
    this.reader = new FileSystemSkillProvider(metadataContext, control, {
      ...config,
      watch: false,
    });
    this.loader = new FileSystemSkillProvider(ctx, control, {
      ...config,
      watch: false,
    });
  }

  async roots(cwd) {
    const roots = await this.reader.roots(cwd);
    roots.push({ path: this.sharedRoot, source: "shared", rank: 600 });
    const seen = new Set();
    const result = [];
    for (const root of roots.sort((a, b) => a.rank - b.rank)) {
      const identity = key(
        await realpath(root.path).catch((error) => {
          if (absent(error)) return root.path;
          throw error;
        }),
      );
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push(root);
    }
    return result;
  }

  async policy() {
    try {
      const data = JSON.parse(await readFile(this.policyFile, "utf8"));
      if (
        data.version !== 1 ||
        !data.enabled ||
        typeof data.enabled !== "object"
      )
        throw new Error("Invalid shared skill preferences");
      return data;
    } catch (error) {
      if (absent(error)) return { version: 1, enabled: {} };
      throw error;
    }
  }

  async inventory(cwd) {
    // Serialize scans: upstream diagnostics are collected per observation.
    const work = this.tail.then(() => this.scan(cwd));
    this.tail = work.catch(() => {});
    return work;
  }

  async scan(cwd) {
    const roots = await this.roots(cwd);
    const policy = await this.policy();
    const files = [];
    const diagnostics = [];
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root.path, { withFileTypes: true });
      } catch (error) {
        if (!absent(error))
          diagnostics.push(`${root.path}: ${error.code ?? error.message}`);
        continue;
      }
      if (entries.length > 2000) {
        diagnostics.push(`${root.path}: skill directory exceeds 2000 entries`);
        continue;
      }
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (root.skipSystem && entry.name === ".system") continue;
        const entryPath = join(root.path, entry.name);
        try {
          const info = await stat(entryPath);
          const file = info.isDirectory()
            ? join(entryPath, "SKILL.md")
            : entry.name.endsWith(".md")
              ? entryPath
              : undefined;
          if (!file) continue;
          const meta = await stat(file);
          if (!meta.isFile()) continue;
          if (meta.size > 1_048_576) {
            diagnostics.push(`${file}: SKILL.md exceeds 1 MiB`);
            continue;
          }
          files.push({
            root,
            file,
            identity: key(await realpath(file)),
            stamp: `${meta.size}:${meta.mtimeMs}:${meta.ctimeMs}`,
          });
        } catch (error) {
          if (!absent(error))
            diagnostics.push(`${entryPath}: ${error.code ?? error.message}`);
        }
      }
    }
    const signature = hash(
      JSON.stringify([
        roots,
        files.map((f) => [f.file, f.identity, f.stamp]),
        policy,
        diagnostics,
      ]),
    );
    const cacheKey = cwd ?? "";
    const previous = this.cache.get(cacheKey);
    if (previous?.signature === signature) return previous;
    this.messages = [];
    // Parse only the bounded, verified files using the pinned upstream parser.
    const candidates = [];
    const seen = new Set();
    for (const file of files) {
      if (seen.has(file.identity)) continue;
      seen.add(file.identity);
      const stub = {
        name: "",
        provider: this.name,
        source: file.root.source,
        locator: { path: file.file, directory: dirname(file.file) },
      };
      const definition = await this.reader.get(stub, {});
      if (!definition) continue;
      const shared = file.root.source === "shared";
      const allowed = !shared || policy.enabled[file.identity] === true;
      candidates.push({
        ...definition,
        rank: file.root.rank,
        locator: stub.locator,
        invocation: allowed
          ? definition.invocation
          : { modelInvocable: false, userInvocable: false },
        catalogRoot: file.root,
        sharedEnabled: allowed,
        identity: file.identity,
        rawDocument: await readFile(file.file, "utf8"),
      });
    }
    const winners = new Map();
    for (const candidate of candidates) {
      // Pending shared entries must not shadow a usable skill from another source.
      const winner = winners.get(candidate.name);
      candidate.shadowedBy = winner?.path;
      if (!winner && candidate.sharedEnabled)
        winners.set(candidate.name, candidate);
    }
    const snapshot = {
      signature,
      roots,
      candidates,
      diagnostics: [...diagnostics, ...this.messages],
    };
    this.cache.set(cacheKey, snapshot);
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    this.control.invalidate();
    return snapshot;
  }

  async list(options = {}) {
    const { candidates } = await this.inventory(options.cwd);
    return candidates
      .filter((candidate) => candidate.sharedEnabled && !candidate.shadowedBy)
      .map(
        ({
          rawDocument,
          catalogRoot,
          sharedEnabled,
          identity,
          shadowedBy,
          ...candidate
        }) => candidate,
      );
  }

  async get(candidate, options = {}) {
    const snapshot = await this.inventory(options.cwd);
    const current = snapshot.candidates.find(
      (item) => item.name === candidate.name && item.path === candidate.path,
    );
    if (!current?.sharedEnabled || current.shadowedBy) return undefined;
    // Shared reads are scoped to the explicitly enabled skill; tool execution
    // continues through Harness's existing sandbox and approval policy.
    return (current.source === "shared" ? this.reader : this.loader).get(
      current,
      options,
    );
  }

  async setEnabled(cwd, file, expectedVersion, enabled) {
    const snapshot = await this.inventory(cwd);
    const candidate = snapshot.candidates.find(
      (item) => item.source === "shared" && item.path === file,
    );
    if (!candidate || this.version(candidate) !== expectedVersion)
      throw new Error("stale_source");
    const policy = await this.policy();
    policy.enabled[candidate.identity] = enabled;
    await mkdir(dirname(this.policyFile), { recursive: true });
    const temporary = `${this.policyFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(policy, null, 2));
    await rename(temporary, this.policyFile);
    this.cache.clear();
    this.control.invalidate();
  }

  version(candidate) {
    return hash(
      JSON.stringify([
        candidate.identity,
        candidate.rawDocument,
        candidate.sharedEnabled,
      ]),
    );
  }
  async dispose() {
    await Promise.all([this.reader.dispose(), this.loader.dispose()]);
  }
}

export const name = "codebuddy-skill-catalog";
export const inject = ["skills"];
export function apply(ctx, config) {
  let catalog;
  ctx.skills.registerProvider(
    (control) => (catalog = new SkillCatalog(ctx, control, config)),
  );
  ctx.provide("codebuddySkillCatalog", catalog);
  ctx.effect(() => () => catalog.dispose());
}
