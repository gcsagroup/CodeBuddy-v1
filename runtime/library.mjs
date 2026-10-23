import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { SkillDownloader } from "./skill-download.mjs";
import { assertRecipeExecutable } from "./recipe-execution.mjs";
import { zRecipeDto } from "../ui/sdk/dist/generated/zod.gen.js";
import { Context } from "./harness/node_modules/@deepseek-ai/cordis/lib/index.js";
import { FileSystemSkillProvider } from "./harness/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js";

const require = createRequire(
  new URL("../ui/desktop/package.json", import.meta.url),
);
const YAML = require("yaml");
const PREFIX = "_goose/unstable/";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const invalid = (reason, detail = reason) =>
  Object.assign(new Error(detail), { code: -32602, data: { reason } });
const unsupported = (feature) =>
  Object.assign(new Error(`This capability is not connected: ${feature}`), {
    code: -32601,
  });
const skillName = (name) =>
  typeof name === "string" &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) &&
  name.length <= 128;
const absent = (error) => error.code === "ENOENT";
const RECIPE_ACTIONS = new Set([
  "list",
  "parse",
  "to-yaml",
  "encode",
  "decode",
  "scan",
  "save",
  "delete",
  "slash-command",
]);
const SKILL_ACTIONS = new Set([
  "list",
  "read",
  "recovery/list",
  "preview",
  "apply",
  "download-preview",
]);

function boundedText(value, label, limit = 1_048_576) {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit)
    throw invalid(
      "invalid_document",
      `${label} must be text within ${limit} bytes`,
    );
  return value;
}

function yamlValue(text) {
  const document = YAML.parseDocument(boundedText(text, "YAML"), {
    uniqueKeys: true,
  });
  if (document.errors.length)
    throw invalid("invalid_frontmatter", document.errors[0].message);
  try {
    return document.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw invalid("invalid_frontmatter", error.message);
  }
}

function documentParts(raw, expectedName) {
  boundedText(raw, "SKILL.md");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(raw);
  if (!match) throw invalid("missing_frontmatter");
  const metadata = yamlValue(match[1]);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !skillName(metadata.name) ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim()
  )
    throw invalid("invalid_frontmatter");
  if (expectedName && metadata.name !== expectedName)
    throw invalid("name_mismatch");
  return { metadata, content: match[2].replace(/^\r?\n/u, "") };
}

function skillDocument(metadata, content) {
  return `---\n${YAML.stringify(metadata).trimEnd()}\n---\n\n${content}`;
}

function inside(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw invalid("source_scope_mismatch");
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw invalid("source_scope_mismatch");
  return target;
}

async function noLinks(target) {
  if (!path.isAbsolute(target)) throw invalid("source_scope_mismatch");
  let current = path.normalize(target);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw invalid("linked_path_rejected");
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}

async function pathIdentity(target) {
  await noLinks(target);
  const identity = [];
  let current = target;
  while (true) {
    try {
      const info = await lstat(current, { bigint: true });
      identity.push([
        current,
        String(info.dev),
        String(info.ino),
        String(info.birthtimeNs),
      ]);
    } catch (error) {
      if (!absent(error)) throw error;
      identity.push([current, "missing"]);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return JSON.stringify(identity);
}

async function atomicWrite(file, data, create = false) {
  await noLinks(file);
  await mkdir(path.dirname(file), { recursive: true });
  if (create) return writeFile(file, data, { flag: "wx", mode: 0o600 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!absent(error)) throw error;
    });
  }
}

async function readDocument(file, label) {
  await noLinks(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 1_048_576)
    throw invalid(
      "invalid_document",
      `${label} must be a regular file within 1 MiB`,
    );
  return boundedText(await readFile(file, "utf8"), label);
}

async function tree(root) {
  await noLinks(root);
  const files = [];
  let bytes = 0;
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      const file = inside(root, name);
      if (entry.isSymbolicLink()) throw invalid("linked_path_rejected");
      if (entry.isDirectory()) await walk(file, name);
      else if (entry.isFile()) {
        const info = await lstat(file);
        if (info.size > 32 * 1024 * 1024 - bytes || files.length >= 512)
          throw invalid("download_size_limit");
        const buffer = await readFile(file);
        bytes += buffer.length;
        if (files.length >= 512 || bytes > 32 * 1024 * 1024)
          throw invalid("download_size_limit");
        files.push({
          relativePath: name.split(path.sep).join("/"),
          buffer,
          version: hash(buffer),
          size: buffer.length,
        });
      } else throw invalid("unsupported_import");
    }
  }
  await walk(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

function treeVersion(files) {
  return hash(
    JSON.stringify(
      files.map(({ relativePath, version }) => [relativePath, version]),
    ),
  );
}

async function publishSkillFiles(target, files) {
  await noLinks(target);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  if (await exists(target)) throw invalid("destination_conflict");
  const expected = await pathIdentity(target);
  // Keep incomplete files outside the directory scanned by Harness discovery.
  const stagingRoot = path.join(
    path.dirname(parent),
    ".codebuddy-skill-staging",
  );
  await noLinks(stagingRoot);
  await mkdir(stagingRoot, { recursive: true });
  const staged = await mkdtemp(path.join(stagingRoot, "install-"));
  try {
    for (const file of files) {
      const stagedFile = inside(staged, file.relativePath);
      await atomicWrite(stagedFile, file.buffer, true);
      if (file.executable) await chmod(stagedFile, 0o700);
    }
    if ((await pathIdentity(target)) !== expected)
      throw invalid("filesystem_identity_changed");
    if (await exists(target)) throw invalid("destination_conflict");
    await rename(staged, target);
  } finally {
    // Only this generated sibling staging directory is eligible for cleanup.
    if (
      path.dirname(path.resolve(staged)) !== path.resolve(stagingRoot) ||
      !path.basename(staged).startsWith("install-")
    )
      throw invalid("source_scope_mismatch");
    await noLinks(staged);
    await rm(staged, { recursive: true, force: true });
  }
}

export class LibraryService {
  constructor(
    store,
    {
      driver,
      workspaces,
      downloader = new SkillDownloader(),
      now = Date.now,
      previewLifetimeMs = 300_000,
    } = {},
  ) {
    if (!store.directory || !path.isAbsolute(store.directory))
      throw invalid("library_directory_required");
    this.store = store;
    this.driver = driver;
    this.workspaces = workspaces;
    this.downloader = downloader;
    this.downloads = new Set();
    this.closed = false;
    this.now = now;
    this.previewLifetimeMs = previewLifetimeMs;
    this.root = path.join(store.directory, "library");
    this.recipeRoot = path.join(this.root, "recipes");
    this.globalSkills = path.join(
      store.directory,
      "harness",
      "agents",
      "skills",
    );
    this.recoveryRoot = path.join(this.root, "skill-recovery");
    this.previews = new Map();
    this.tail = Promise.resolve();
  }

  serial(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  handles(method, params = {}) {
    if (method === PREFIX + "sources/import") {
      try {
        if (JSON.parse(params.data)?.type === "project") return false;
      } catch {
        /* request validates the import document */
      }
    }
    return (
      (method.startsWith(PREFIX + "recipes/") &&
        RECIPE_ACTIONS.has(method.slice((PREFIX + "recipes/").length))) ||
      (method.startsWith(PREFIX + "skills/manage/") &&
        SKILL_ACTIONS.has(method.slice((PREFIX + "skills/manage/").length))) ||
      [PREFIX + "slash-commands/list", PREFIX + "agent-mentions/list"].includes(
        method,
      ) ||
      (method.startsWith(PREFIX + "sources/") && params.type !== "project")
    );
  }

  async request(method, params = {}, connection) {
    if (!this.handles(method, params)) return undefined;
    if (method.startsWith(PREFIX + "recipes/"))
      return this.recipeRequest(
        method.slice((PREFIX + "recipes/").length),
        params,
      );
    if (method.startsWith(PREFIX + "skills/manage/"))
      return this.skillRequest(
        method.slice((PREFIX + "skills/manage/").length),
        params,
        connection,
      );
    if (method === PREFIX + "slash-commands/list") {
      const recipes = await this.listRecipes();
      const skills = (await this.listSkills(params.cwd)).skills.filter(
        (skill) => skill.enabled,
      );
      return {
        availableCommands: [
          ...recipes
            .filter((entry) => entry.slash_command)
            .map((entry) => ({
              name: entry.slash_command,
              description: entry.recipe.description,
              _meta: { recipeId: entry.id, commandType: "Recipe", sourcePath: entry.file_path },
            })),
          ...skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            _meta: { skillPath: skill.displayPath, commandType: "Skill" },
          })),
        ],
      };
    }
    if (method === PREFIX + "agent-mentions/list") {
      const recipes = await this.listRecipes();
      const agents = await this.listAgents(params.projectDir ?? params.cwd);
      return {
        agents: [
          ...recipes.map((entry) => ({
            name: entry.recipe.title,
            description: entry.recipe.description,
            sourceType: "recipe",
            sourcePath: entry.file_path,
            mention: `@${entry.recipe.title}`,
          })),
          ...agents.map((entry) => ({
            name: entry.name,
            description: entry.description,
            sourceType: "agent",
            sourcePath: entry.path,
            mention: `@${entry.name}`,
          })),
        ],
      };
    }
    return this.sourceRequest(
      method.slice((PREFIX + "sources/").length),
      params,
      connection,
    );
  }

  recipe(value) {
    try {
      const parsed = zRecipeDto.parse(value);
      if (
        !parsed.title.trim() ||
        !parsed.description.trim() ||
        (!parsed.instructions?.trim() && !parsed.prompt?.trim())
      )
        throw invalid(
          "invalid_recipe",
          "A recipe needs title, description, and instructions or prompt",
        );
      return parsed;
    } catch (error) {
      if (error.code) throw error;
      throw invalid("invalid_recipe", error.message);
    }
  }

  decodeRecipe(deeplink) {
    boundedText(deeplink, "Recipe link", 2_000_000);
    try {
      return this.recipe(
        JSON.parse(
          Buffer.from(decodeURIComponent(deeplink), "base64url").toString(
            "utf8",
          ),
        ),
      );
    } catch (error) {
      throw invalid("invalid_recipe", `Invalid recipe link: ${error.message}`);
    }
  }

  async listRecipes() {
    await noLinks(this.recipeRoot);
    await mkdir(this.recipeRoot, { recursive: true });
    const names = (await readdir(this.recipeRoot)).filter((name) =>
      /^[0-9a-f-]{36}\.yaml$/u.test(name),
    );
    const state = this.store.read();
    const slashes = state.recipeSlashCommands ?? {};
    return Promise.all(
      names.map(async (name) => {
        const file = inside(this.recipeRoot, name);
        await noLinks(file);
        const id = name.slice(0, -5);
        return {
          id,
          recipe: this.recipe(yamlValue(await readDocument(file, "Recipe"))),
          file_path: file,
          last_modified: (await stat(file)).mtime.toISOString(),
          schedule_cron:
            state.schedules?.find((job) => job.recipeId === id)?.cron ?? null,
          slash_command: slashes[id] ?? null,
        };
      }),
    );
  }

  async getRecipe(id) {
    const entry = (await this.listRecipes()).find((item) => item.id === id);
    if (!entry) throw invalid("recipe_not_found");
    return entry.recipe;
  }

  async recipeRequest(action, input) {
    if (action === "list") return { recipes: await this.listRecipes() };
    if (action === "parse")
      return { recipe: this.recipe(yamlValue(input.content)) };
    if (action === "to-yaml")
      return { yaml: YAML.stringify(this.recipe(input.recipe)) };
    if (action === "encode")
      return {
        deeplink: Buffer.from(
          JSON.stringify(this.recipe(input.recipe)),
        ).toString("base64url"),
      };
    if (action === "decode")
      return { recipe: this.decodeRecipe(input.deeplink) };
    if (action === "scan") {
      const recipe = this.recipe(input.recipe);
      return {
        has_security_warnings: Boolean(
          recipe.extensions?.some(
            (extension) =>
              extension.type === "stdio" ||
              extension.type === "streamable_http",
          ) ||
          recipe.retry?.checks?.length ||
          recipe.sub_recipes?.length,
        ),
      };
    }
    if (action === "save")
      return this.serial(async () => {
        const recipe = this.recipe(input.recipe);
        assertRecipeExecutable(recipe);
        const current = input.id
          ? (await this.listRecipes()).find((entry) => entry.id === input.id)
          : null;
        if (input.id && !current) throw invalid("recipe_not_found");
        const id = current?.id ?? randomUUID();
        const file = inside(this.recipeRoot, `${id}.yaml`);
        await atomicWrite(file, YAML.stringify(recipe), !current);
        return { id, file_name: path.basename(file), file_path: file };
      });
    if (action === "delete")
      return this.serial(async () => {
        const entry = (await this.listRecipes()).find(
          (item) => item.id === input.id,
        );
        if (!entry) throw invalid("recipe_not_found");
        await unlink(entry.file_path);
        await this.store.update((state) => {
          if (state.recipeSlashCommands)
            delete state.recipeSlashCommands[input.id];
        });
        return {};
      });
    if (action === "slash-command") {
      await this.getRecipe(input.id);
      const command = input.slash_command?.replace(/^\//u, "");
      if (command && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(command))
        throw invalid("invalid_slash_command");
      return this.store.update((state) => {
        const commands = (state.recipeSlashCommands ??= {});
        if (
          command &&
          Object.entries(commands).some(
            ([id, value]) => id !== input.id && value === command,
          )
        )
          throw invalid("slash_command_conflict");
        if (command) commands[input.id] = command;
        else delete commands[input.id];
        return {};
      });
    }
    throw unsupported(`recipes/${action}`);
  }

  async roots(projectDir) {
    const result = [
      { rootKind: "global", displayPath: this.globalSkills, readOnly: false },
    ];
    if (projectDir) {
      if (!path.isAbsolute(projectDir)) throw invalid("project_not_found");
      await noLinks(projectDir);
      if (!(await stat(projectDir)).isDirectory())
        throw invalid("project_not_found");
      result.push({
        rootKind: "project_agents",
        displayPath: path.join(await realpath(projectDir), ".agents", "skills"),
        readOnly: false,
      });
    }
    for (const root of result) {
      await noLinks(root.displayPath);
      root.rootId = hash(path.resolve(root.displayPath)).slice(0, 24);
    }
    return result;
  }

  async sourcePath(projectDir, source) {
    const root = (await this.roots(projectDir)).find(
      (item) =>
        item.rootId === source?.rootId && item.rootKind === source?.rootKind,
    );
    if (!root) throw invalid("source_scope_mismatch");
    const target = inside(root.displayPath, source.relativePath);
    await noLinks(target);
    return { root, target };
  }

  async managedSkill(projectDir, source) {
    if (source?.rootKind === "builtin") {
      const skill = (await this.builtinManagedSkills(projectDir)).find(item =>
        item.source.rootId === source.rootId && item.source.relativePath === source.relativePath);
      if (!skill) throw invalid("source_not_found");
      return skill;
    }
    const { root, target } = await this.sourcePath(projectDir, source);
    let files;
    if ((await stat(target)).isFile()) {
      const buffer = Buffer.from(await readDocument(target, "SKILL.md"));
      files = [
        {
          relativePath: path.basename(target),
          buffer,
          size: buffer.length,
          version: hash(buffer),
        },
      ];
    } else files = await tree(target);
    const instruction =
      files.find((file) => file.relativePath === "SKILL.md") ??
      (files.length === 1 && target.endsWith(".md") ? files[0] : null);
    if (!instruction) throw invalid("missing_skill_document");
    const rawDocument = instruction.buffer.toString("utf8");
    const { metadata } = documentParts(rawDocument);
    return {
      source,
      name: metadata.name,
      description: metadata.description,
      scope: root.rootKind === "global" ? "global" : "project",
      readOnly: false,
      enabled: metadata["disable-model-invocation"] !== true,
      displayPath: target,
      version: treeVersion(files),
      rawDocument,
      originalMetadata: metadata,
      displayMetadata: metadata.metadata?.display ?? {},
      companionFiles: files
        .filter((file) => file !== instruction)
        .map(({ relativePath, size, version }) => ({
          relativePath,
          size,
          version,
        })),
    };
  }

  async listSkills(projectDir) {
    const roots = await this.roots(projectDir);
    const controller = new AbortController();
    const provider = new FileSystemSkillProvider(
      new Context(),
      { invalidate() {}, signal: controller.signal },
      {
        includeDefaultRoots: false,
        customSkillDirs: roots.map((root) => root.displayPath),
        watch: false,
      },
    );
    try {
      const observation = await provider.list({ cwd: projectDir });
      if (!Array.isArray(observation) && !observation.complete)
        throw invalid("skill_discovery_incomplete");
      const skills = [];
      for (const candidate of Array.isArray(observation)
        ? observation
        : observation.candidates) {
        const root = roots.find((item) =>
          candidate.path?.startsWith(item.displayPath + path.sep),
        );
        if (!root) continue;
        const itemPath =
          path.basename(candidate.path) === "SKILL.md"
            ? path.dirname(candidate.path)
            : candidate.path;
        skills.push(
          await this.managedSkill(projectDir, {
            rootKind: root.rootKind,
            rootId: root.rootId,
            relativePath: path.relative(root.displayPath, itemPath),
          }),
        );
      }
      return { skills, destinationRoots: roots };
    } finally {
      controller.abort();
      await provider.dispose();
    }
  }

  async builtinManagedSkills(projectDir) {
    const definitions = await this.driver?.listBuiltinSkills?.(projectDir) ?? [];
    return definitions.map(skill => ({
      source: { rootKind: "builtin", rootId: skill.provider, relativePath: skill.name },
      name: skill.name, description: skill.description, scope: "builtin",
      readOnly: true, enabled: true, displayPath: `builtin/${skill.name}`,
      version: hash(skill.content), rawDocument: skill.content,
      originalMetadata: { name: skill.name, description: skill.description },
      displayMetadata: { locales: {} }, companionFiles: [],
    }));
  }

  async skillRequest(action, input, connection) {
    if (action === "list") {
      const result = await this.listSkills(input.projectDir);
      result.skills.push(...await this.builtinManagedSkills(input.projectDir));
      return result;
    }
    if (action === "read")
      return { skill: await this.managedSkill(input.projectDir, input.source) };
    if (action === "recovery/list")
      return { entries: await this.listRecoveries(input.projectDir) };
    if (action === "preview") return this.preview(input, connection);
    if (action === "download-preview")
      return this.previewDownload(input, connection);
    if (action === "apply") return this.apply(input.previewToken, connection);
    throw unsupported(`skills/manage/${action}`);
  }

  async listRecoveries(projectDir) {
    const allowed = await this.roots(projectDir);
    await noLinks(this.recoveryRoot);
    await mkdir(this.recoveryRoot, { recursive: true });
    const entries = [];
    for (const item of await readdir(this.recoveryRoot, {
      withFileTypes: true,
    })) {
      if (!item.isDirectory() || !/^[0-9a-f-]{36}$/u.test(item.name)) continue;
      const folder = inside(this.recoveryRoot, item.name);
      await noLinks(folder);
      const metadata = JSON.parse(
        await readFile(path.join(folder, "recovery.json"), "utf8"),
      );
      if (
        (await exists(path.join(folder, "payload"))) &&
        allowed.some((root) => root.rootId === metadata.source.rootId)
      )
        entries.push(metadata);
    }
    return entries;
  }

  async inspectChange(projectDir, change) {
    if (!change || typeof change !== "object") throw invalid("invalid_preview");
    const operation = change.operation;
    let current;
    let target;
    let files;
    let source;
    let rawDocument;
    if (change.source) {
      current = await this.managedSkill(projectDir, change.source);
      if (current.version !== change.expectedVersion)
        throw invalid("stale_source");
      source = change.source;
      target = current.displayPath;
      if (current.readOnly && operation !== "copy") throw invalid("read_only");
    }
    if (change.destination) {
      if (!skillName(change.destination.name)) throw invalid("missing_name");
      source = {
        rootKind: change.destination.rootKind,
        rootId: change.destination.rootId,
        relativePath: change.destination.name,
      };
      target = (await this.sourcePath(projectDir, source)).target;
    }
    if (operation === "create") {
      rawDocument = change.rawDocument;
      documentParts(rawDocument, change.destination.name);
      files = [{ relativePath: "SKILL.md", buffer: Buffer.from(rawDocument) }];
    } else if (operation === "update_raw") {
      rawDocument = change.rawDocument;
      const parsed = documentParts(rawDocument, current.name);
      if (change.displayMetadata)
        rawDocument = skillDocument(
          {
            ...parsed.metadata,
            metadata: {
              ...parsed.metadata.metadata,
              display: change.displayMetadata,
            },
          },
          parsed.content,
        );
    } else if (operation === "set_enabled") {
      if (typeof change.enabled !== "boolean") throw invalid("invalid_preview");
      const parsed = documentParts(current.rawDocument);
      rawDocument = skillDocument(
        {
          ...parsed.metadata,
          "disable-model-invocation": !change.enabled,
          "user-invocable": change.enabled,
        },
        parsed.content,
      );
    } else if (operation === "import_local" || operation === "copy") {
      let inputPath =
        operation === "copy" ? current.displayPath : change.sourcePath;
      if (typeof inputPath !== "string" || !path.isAbsolute(inputPath))
        throw invalid("import_not_found");
      await noLinks(inputPath);
      if ((await stat(inputPath)).isFile()) {
        if (path.basename(inputPath) !== "SKILL.md")
          throw invalid("unsupported_import");
        inputPath = path.dirname(inputPath);
      }
      files = await tree(inputPath);
      const instruction = files.find(
        (file) => file.relativePath === "SKILL.md",
      );
      if (!instruction) throw invalid("missing_skill_document");
      const parsed = documentParts(instruction.buffer.toString("utf8"));
      const importVersion = treeVersion(files);
      files = files.map((file) =>
        file === instruction
          ? {
              ...file,
              buffer: Buffer.from(
                skillDocument(
                  { ...parsed.metadata, name: change.destination.name },
                  parsed.content,
                ),
              ),
            }
          : file,
      );
      return {
        operation,
        current,
        target,
        files,
        source,
        importPath: inputPath,
        importVersion,
        identity: await pathIdentity(target),
        importIdentity: await pathIdentity(inputPath),
        hasConflict: await exists(target),
        requiresConfirmation: false,
      };
    } else if (operation === "restore") {
      const recovery = (await this.listRecoveries(projectDir)).find(
        (entry) => entry.recoveryRef === change.recoveryRef,
      );
      if (!recovery) throw invalid("recovery_not_found");
      source = recovery.source;
      target = (await this.sourcePath(projectDir, source)).target;
      const payload = path.join(
        this.recoveryRoot,
        recovery.recoveryRef,
        "payload",
      );
      const storedFiles = (await stat(payload)).isDirectory()
        ? await tree(payload)
        : [
            {
              relativePath: path.basename(target),
              version: hash(await readFile(payload)),
            },
          ];
      if (treeVersion(storedFiles) !== recovery.version)
        throw invalid("stale_source");
      return {
        operation,
        target,
        source,
        recovery,
        identity: await pathIdentity(target),
        importIdentity: await pathIdentity(payload),
        hasConflict: await exists(target),
        requiresConfirmation: false,
      };
    } else if (operation !== "delete")
      throw unsupported(`skill operation ${operation}`);
    if (!target || !source) throw invalid("invalid_preview");
    return {
      operation,
      current,
      target,
      source,
      files,
      rawDocument,
      identity: await pathIdentity(target),
      hasConflict: operation === "create" && (await exists(target)),
      requiresConfirmation: operation === "delete",
    };
  }

  async preview(input, connection) {
    for (const [token, item] of this.previews)
      if (item.expires <= this.now() && !item.applying)
        this.previews.delete(token);
    const inspected = await this.inspectChange(input.projectDir, input.change);
    return this.registerPreview(inspected, input, connection);
  }

  registerPreview(inspected, input, connection) {
    const token = randomUUID();
    const expires = this.now() + this.previewLifetimeMs;
    this.previews.set(token, {
      ...inspected,
      connection,
      change: structuredClone(input.change),
      projectDir: input.projectDir,
      expires,
    });
    return {
      previewToken: token,
      expiresAt: new Date(expires).toISOString(),
      operation: inspected.operation,
      target: inspected.target,
      requiresConfirmation: inspected.requiresConfirmation,
      hasConflict: Boolean(inspected.hasConflict),
      files: inspected.files?.map((file) => file.relativePath) ?? ["SKILL.md"],
      diff: inspected.rawDocument
        ? `--- current\n${inspected.current?.rawDocument ?? ""}\n+++ proposed\n${inspected.rawDocument}`
        : null,
    };
  }

  async inspectDownload(projectDir, change, download) {
    if (
      !skillName(change.destination?.name) ||
      change.destination.name.length > 64
    )
      throw invalid("missing_name");
    const source = {
      rootKind: change.destination.rootKind,
      rootId: change.destination.rootId,
      relativePath: change.destination.name,
    };
    const { target } = await this.sourcePath(projectDir, source);
    const files = download.files.map((file) => ({
      ...file,
      version: hash(file.buffer),
      size: file.buffer.length,
    }));
    return {
      operation: "download",
      source,
      target,
      files,
      importVersion: treeVersion(files),
      identity: await pathIdentity(target),
      hasConflict: await exists(target),
      requiresConfirmation: false,
      download,
    };
  }

  async previewDownload(input, connection) {
    if (this.closed) throw invalid("download_failed");
    for (const [token, preview] of this.previews)
      if (preview.expires <= this.now() && !preview.applying)
        this.previews.delete(token);
    if (
      this.downloads.size >= 4 ||
      [...this.previews.values()].filter((item) => item.download).length >= 16
    )
      throw invalid("download_size_limit");
    const change = { destination: structuredClone(input.destination) };
    const row = { connection, controller: new AbortController() };
    this.downloads.add(row);
    try {
      await this.inspectDownload(input.projectDir, change, { files: [] });
      row.controller.signal.throwIfAborted();
      const download = await this.downloader.download(input.url, {
        signal: row.controller.signal,
      });
      row.controller.signal.throwIfAborted();
      const instruction = download.files.find(
        (file) => file.relativePath === "SKILL.md",
      );
      if (!instruction) throw invalid("missing_skill_document");
      let raw;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          instruction.buffer,
        );
      } catch {
        throw invalid("invalid_skill_document");
      }
      const parsed = documentParts(raw);
      if (
        parsed.metadata.name.length > 64 ||
        parsed.metadata.description.length > 1024 ||
        (parsed.metadata.license !== undefined &&
          typeof parsed.metadata.license !== "string")
      )
        throw invalid("invalid_skill_document");
      instruction.buffer = Buffer.from(
        skillDocument(
          { ...parsed.metadata, name: change.destination.name },
          parsed.content,
        ),
      );
      download.provenance.installedSkill = {
        sourceName: parsed.metadata.name,
        name: change.destination.name,
        documentSha256: hash(instruction.buffer),
      };
      const provenanceFile = download.files.find(
        (file) => file.relativePath === ".codebuddy-source.json",
      );
      if (provenanceFile)
        provenanceFile.buffer = Buffer.from(
          JSON.stringify(download.provenance, null, 2) + "\n",
        );
      const inspected = await this.inspectDownload(
        input.projectDir,
        change,
        download,
      );
      row.controller.signal.throwIfAborted();
      const response = this.registerPreview(
        inspected,
        { projectDir: input.projectDir, change },
        connection,
      );
      return {
        ...response,
        diff: `source: ${download.displaySource}\n\n${instruction.buffer.toString("utf8")}`,
      };
    } catch (error) {
      if (row.controller.signal.aborted) throw invalid("download_failed");
      throw error;
    } finally {
      this.downloads.delete(row);
    }
  }

  async apply(token, connection) {
    const pending = this.previews.get(token);
    if (!pending || pending.connection !== connection || pending.applying)
      throw invalid("invalid_preview");
    if (pending.expires <= this.now()) {
      this.previews.delete(token);
      throw invalid("expired_preview");
    }
    pending.applying = true;
    try {
      if (pending.requiresConfirmation) {
        if (!connection?.ask) throw invalid("confirmation_required");
        const nonce = randomUUID();
        const response = await connection.ask(
          PREFIX + "skills/manage/request-confirmation",
          {
            previewToken: token,
            nonce,
            operation: pending.operation,
            target: pending.target,
            source: pending.current?.source,
            expectedVersion: pending.current?.version,
            expiresAt: new Date(pending.expires).toISOString(),
          },
          AbortSignal.timeout(Math.max(1, pending.expires - this.now())),
        );
        if (response?.decision !== "confirm")
          throw invalid("confirmation_cancelled");
        if (response.nonce !== nonce) throw invalid("invalid_confirmation");
      }
      return await this.serial(async () => {
        if (pending.expires <= this.now()) throw invalid("expired_preview");
        const fresh = pending.download
          ? await this.inspectDownload(
              pending.projectDir,
              pending.change,
              pending.download,
            )
          : await this.inspectChange(pending.projectDir, pending.change);
        if (
          fresh.target !== pending.target ||
          fresh.importVersion !== pending.importVersion
        )
          throw invalid("stale_import_source");
        if (
          fresh.identity !== pending.identity ||
          fresh.importIdentity !== pending.importIdentity
        )
          throw invalid("filesystem_identity_changed");
        if (fresh.hasConflict)
          throw invalid(
            fresh.operation === "restore"
              ? "restore_conflict"
              : "destination_conflict",
          );
        let result;
        if (fresh.operation === "delete") {
          const recoveryRef = randomUUID();
          const folder = inside(this.recoveryRoot, recoveryRef);
          const record = {
            recoveryRef,
            source: fresh.source,
            name: fresh.current.name,
            version: fresh.current.version,
            deletedAt: new Date(this.now()).toISOString(),
          };
          await atomicWrite(
            path.join(folder, "recovery.json"),
            JSON.stringify(record, null, 2),
            true,
          );
          await rename(fresh.target, path.join(folder, "payload"));
          result = { recoveryRef };
        } else if (fresh.operation === "restore") {
          await mkdir(path.dirname(fresh.target), { recursive: true });
          await rename(
            path.join(this.recoveryRoot, fresh.recovery.recoveryRef, "payload"),
            fresh.target,
          );
          result = {
            skill: await this.managedSkill(pending.projectDir, fresh.source),
          };
        } else if (fresh.files) {
          await publishSkillFiles(fresh.target, fresh.files);
          result = {
            skill: await this.managedSkill(pending.projectDir, fresh.source),
          };
        } else {
          const file = (await stat(fresh.target)).isFile()
            ? fresh.target
            : path.join(fresh.target, "SKILL.md");
          await atomicWrite(file, fresh.rawDocument);
          result = {
            skill: await this.managedSkill(pending.projectDir, fresh.source),
          };
        }
        await this.driver?.refreshSkills?.(fresh.target);
        return result;
      });
    } finally {
      this.previews.delete(token);
    }
  }

  async sourceRequest(action, input, connection) {
    if (input.target?.scope === "projectId") {
      if (!this.workspaces?.resolveProjectDirectory)
        throw unsupported("project source resolution");
      const projectDir = await this.workspaces.resolveProjectDirectory(
        input.target.projectId,
        input.projectDir,
      );
      input = {
        ...input,
        projectDir,
        target: { scope: "projectDir", projectDir },
      };
    }
    const importedType =
      action === "import" ? JSON.parse(input.data)?.type : undefined;
    const type = input.type ?? importedType ?? "skill";
    if (type === "agent") return this.agentSourceRequest(action, input);
    if (type === "builtinSkill" && action === "list") {
      const skills = await this.driver?.listBuiltinSkills?.(input.projectDir) ?? [];
      return { sources: skills.map(skill => ({
        type: "builtinSkill", name: skill.name, description: skill.description,
        content: skill.content, path: `builtin/${skill.name}`, global: true,
        writable: false, supportingFiles: [], properties: { provider: skill.provider },
      })) };
    }
    if (type !== "skill") throw unsupported(`sources/${type}/${action}`);
    const projectDir =
      input.projectDir ??
      (input.target?.scope === "projectDir"
        ? input.target.projectDir
        : undefined);
    const managed = await this.listSkills(projectDir);
    const sourceEntry = (skill) => {
      const parsed = documentParts(skill.rawDocument);
      return {
        type: "skill",
        name: skill.name,
        description: skill.description,
        content: parsed.content,
        path: skill.displayPath,
        global: skill.scope === "global",
        writable: !skill.readOnly,
        supportingFiles: skill.companionFiles.map((file) =>
          path.join(skill.displayPath, file.relativePath),
        ),
        properties: parsed.metadata.metadata ?? {},
      };
    };
    if (action === "list") return { sources: managed.skills.map(sourceEntry) };
    const current = managed.skills.find(
      (skill) => skill.displayPath === input.path,
    );
    if (action === "export") {
      if (!current) throw invalid("source_not_found");
      const entry = sourceEntry(current);
      return {
        json: JSON.stringify({
          version: 1,
          type: "skill",
          name: entry.name,
          description: entry.description,
          content: entry.content,
          properties: entry.properties,
        }),
        filename: `${entry.name}.skill.json`,
      };
    }
    if (action === "import") {
      const value = JSON.parse(input.data);
      if (value.version !== 1 || value.type !== "skill")
        throw invalid("unsupported_import");
      let name = value.name;
      for (let i = 1; managed.skills.some((skill) => skill.name === name); i++)
        name = `${value.name}-imported${i === 1 ? "" : `-${i}`}`;
      const result = await this.sourceRequest(
        "create",
        { ...value, type: "skill", name, target: input.target, projectDir },
        connection,
      );
      return { sources: [result.source] };
    }
    let change;
    if (action === "create") {
      const root = managed.destinationRoots.find(
        (item) =>
          item.rootKind ===
          (input.target?.scope === "projectDir" ? "project_agents" : "global"),
      );
      if (!root || !["global", "projectDir"].includes(input.target?.scope))
        throw invalid("source_scope_mismatch");
      change = {
        operation: "create",
        destination: { ...root, name: input.name },
        rawDocument: skillDocument(
          {
            name: input.name,
            description: input.description,
            metadata: input.properties ?? {},
          },
          input.content,
        ),
      };
    } else {
      if (!current) throw invalid("source_not_found");
      if (action === "delete")
        change = {
          operation: "delete",
          source: current.source,
          expectedVersion: current.version,
        };
      else if (action === "update") {
        const parsed = documentParts(current.rawDocument);
        change = {
          operation: "update_raw",
          source: current.source,
          expectedVersion: current.version,
          rawDocument: skillDocument(
            {
              ...parsed.metadata,
              name: input.name,
              description: input.description,
              metadata: input.properties ?? parsed.metadata.metadata,
            },
            input.content,
          ),
        };
      } else throw unsupported(`sources/skill/${action}`);
    }
    const preview = await this.preview({ projectDir, change }, connection);
    const result = await this.apply(preview.previewToken, connection);
    return result.skill ? { source: sourceEntry(result.skill) } : {};
  }

  async listAgents(projectDir) {
    const roots = [{ path: path.join(this.root, "agents"), global: true }];
    if (projectDir) {
      await this.roots(projectDir);
      roots.push({
        path: path.join(projectDir, ".agents", "agents"),
        global: false,
      });
    }
    const result = [];
    for (const root of roots) {
      await noLinks(root.path);
      if (!(await exists(root.path))) continue;
      for (const item of await readdir(root.path, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith(".md")) continue;
        const file = inside(root.path, item.name);
        await noLinks(file);
        const raw = await readDocument(file, "Agent source");
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(
          raw,
        );
        if (!match) throw invalid("missing_frontmatter");
        const { name, description, ...properties } = yamlValue(match[1]);
        if (typeof name !== "string" || typeof description !== "string")
          throw invalid("invalid_frontmatter");
        result.push({
          type: "agent",
          name,
          description,
          content: match[2].replace(/^\r?\n/u, ""),
          path: file,
          global: root.global,
          writable: true,
          supportingFiles: [],
          properties,
        });
      }
    }
    return result;
  }

  async getAgent(name, projectDir) {
    const agents = await this.listAgents(projectDir);
    return (
      agents.find((entry) => !entry.global && entry.name === name) ??
      agents.find((entry) => entry.name === name)
    );
  }

  async agentSourceRequest(action, input) {
    const projectDir =
      input.projectDir ??
      (input.target?.scope === "projectDir"
        ? input.target.projectDir
        : undefined);
    const sources = await this.listAgents(projectDir);
    const current = sources.find((entry) => entry.path === input.path);
    if (action === "list") return { sources };
    if (action === "export") {
      if (!current) throw invalid("source_not_found");
      return {
        json: JSON.stringify({
          version: 1,
          type: "agent",
          name: current.name,
          description: current.description,
          content: current.content,
          properties: current.properties,
        }),
        filename: `${path.basename(current.path, ".md")}.agent.json`,
      };
    }
    if (action === "import") {
      const value = JSON.parse(input.data);
      if (value.version !== 1 || value.type !== "agent")
        throw invalid("unsupported_import");
      let name = value.name;
      for (let index = 1; sources.some((entry) => entry.name === name); index++)
        name = `${value.name} imported${index === 1 ? "" : ` ${index}`}`;
      const { source } = await this.agentSourceRequest("create", {
        ...value,
        name,
        target: input.target,
      });
      return { sources: [source] };
    }
    return this.serial(async () => {
      if (action === "delete") {
        if (!current) throw invalid("source_not_found");
        await noLinks(current.path);
        await unlink(current.path);
        return {};
      }
      if (!["create", "update"].includes(action))
        throw unsupported(`sources/agent/${action}`);
      if (
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 80 ||
        /[\\/\0]/u.test(input.name)
      )
        throw invalid("invalid_agent_name");
      boundedText(input.description, "Agent description");
      boundedText(input.content, "Agent instructions");
      if (action === "update" && !current) throw invalid("source_not_found");
      if (
        action === "create" &&
        !["global", "projectDir"].includes(input.target?.scope)
      )
        throw invalid("source_scope_mismatch");
      const root = (
        action === "create" ? input.target?.scope === "projectDir" : projectDir
      )
        ? path.join(projectDir, ".agents", "agents")
        : path.join(this.root, "agents");
      const slug =
        input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-|-$/gu, "") || "agent";
      const file =
        current?.path ??
        inside(root, `${slug}-${hash(input.name).slice(0, 8)}.md`);
      const properties = input.properties ?? current?.properties ?? {};
      const document = skillDocument(
        { ...properties, name: input.name, description: input.description },
        input.content,
      );
      await atomicWrite(file, document, !current);
      return {
        source: (await this.listAgents(projectDir)).find(
          (entry) => entry.path === file,
        ),
      };
    });
  }

  disconnect(connection) {
    for (const download of this.downloads)
      if (download.connection === connection) download.controller.abort();
    for (const [token, preview] of this.previews)
      if (preview.connection === connection && !preview.applying)
        this.previews.delete(token);
  }

  async close() {
    this.closed = true;
    for (const download of this.downloads) download.controller.abort();
    this.previews.clear();
    await this.tail;
  }
}
