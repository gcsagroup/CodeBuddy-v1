import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { acquireProfileLock } from "./profile-lock.mjs";
import { openStore } from "./store.mjs";
import { modelBase } from "./providers.mjs";
import { protectSecret } from "./secrets.mjs";
import { validatePreference } from "./settings.mjs";
import { recipeExtensions } from "./recipe-execution.mjs";
import { ScheduleService } from "./schedules.mjs";
import { ProjectMemory } from "./memory.mjs";
import { validateConversation } from "./history.mjs";

const require = createRequire(
  new URL("../ui/desktop/package.json", import.meta.url),
);
const YAML = require("yaml");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const fail = (reason) =>
  Object.assign(new Error(reason), { code: "LEGACY_MIGRATION", reason });
const identity = (source) =>
  `legacy-${hash(process.platform === "win32" ? source.toLowerCase() : source).slice(0, 24)}`;
const stamp = (value, fallback) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
const preferences = {
  GOOSE_MODE: "gooseMode",
  GOOSE_THINKING_EFFORT: "gooseThinkingEffort",
  GOOSE_MAX_TURNS: "gooseMaxTurns",
  GOOSE_AUTO_COMPACT_THRESHOLD: "autoCompactThreshold",
  CODEPRO_PERSONALIZED_MEMORY_ENABLED: "personalizedMemoryEnabled",
};
const builtinNames = new Set([
  "developer",
  "projectmemory",
  "git",
  "qwen_computer",
  "computercontroller",
  "autovisualiser",
]);

async function noLinks(file) {
  let current = path.resolve(file);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw fail("linked_path_rejected");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
async function readBounded(file, limit = 8 * 1024 * 1024) {
  await noLinks(file);
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) throw fail("legacy_file_size_limit");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw fail("legacy_file_size_limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function optional(file, parser, fallback) {
  try {
    return parser(await readBounded(file));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function yaml(text) {
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw fail("invalid_legacy_yaml");
  return document.toJS({ maxAliasCount: 50 });
}
async function children(directory) {
  await noLinks(directory);
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function openDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    for (const [table, required] of [
      [
        "sessions",
        [
          "id",
          "name",
          "working_dir",
          "session_type",
          "created_at",
          "updated_at",
        ],
      ],
      [
        "messages",
        ["id", "session_id", "role", "content_json", "created_timestamp"],
      ],
    ]) {
      const columns = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (required.some((column) => !columns.includes(column)))
        throw fail("unsupported_legacy_database_schema");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
function databaseSummary(database) {
  return {
    sessions: database.prepare("SELECT COUNT(*) AS count FROM sessions").get()
      .count,
    visibleSessions: database
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE session_type IN ('user','code_pro')",
      )
      .get().count,
    messages: database.prepare("SELECT COUNT(*) AS count FROM messages").get()
      .count,
  };
}
async function sourceData(sourceDir) {
  await noLinks(sourceDir);
  const source = await realpath(sourceDir);
  const config = await optional(
    path.join(source, "config", "config.yaml"),
    yaml,
    {},
  );
  if (!record(config)) throw fail("invalid_legacy_config");
  const providers = [];
  for (const entry of await children(
    path.join(source, "config", "custom_providers"),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    providers.push({
      file: entry.name,
      value: JSON.parse(
        await readBounded(
          path.join(source, "config", "custom_providers", entry.name),
        ),
      ),
    });
  }
  const memories = [];
  for (const entry of await children(path.join(source, "memory"))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/u.test(entry.name)) continue;
    const value = await optional(
      path.join(source, "memory", entry.name, "memory.json"),
      JSON.parse,
      null,
    );
    if (!value) continue;
    if (
      !["1.0", "2.0"].includes(value.schema_version) ||
      value.project_identity !== entry.name ||
      !Array.isArray(value.entries)
    )
      throw fail("unsupported_legacy_memory_schema");
    memories.push({ identity: entry.name, value });
  }
  const schedules = await optional(
    path.join(source, "schedule.json"),
    JSON.parse,
    [],
  );
  if (!Array.isArray(schedules)) throw fail("invalid_legacy_schedules");
  return { source, config, providers, memories, schedules };
}

/** Read-only inventory: never emits configuration values or message bodies. */
export async function inspectLegacyProfile({
  sourceDir,
  targetDir,
  projectMap = {},
}) {
  const data = await sourceData(sourceDir);
  const databaseFile = path.join(data.source, "sessions", "sessions.db");
  await noLinks(databaseFile);
  const database = openDatabase(databaseFile);
  let history;
  try {
    history = {
      ...databaseSummary(database),
      bytes: (await stat(databaseFile)).size,
    };
  } finally {
    database.close();
  }
  return {
    version: 1,
    mode: "dry-run",
    archiveId: identity(data.source),
    source: data.source,
    target: targetDir ? path.resolve(targetDir) : null,
    history,
    configuration: {
      customProviders: data.providers.length,
      extensions: Object.keys(data.config.extensions ?? {}).length,
      preferenceKeys: Object.keys(preferences).filter(
        (key) => key in data.config,
      ),
      credentialPolicy:
        "Legacy keyring credentials require re-entry; current target defaults and credentials are preserved",
    },
    memory: {
      files: data.memories.length,
      records: data.memories.reduce(
        (sum, item) => sum + item.value.entries.length,
        0,
      ),
      unmappedIdentities: data.memories
        .filter((item) => !projectMap[item.identity])
        .map((item) => item.identity),
    },
    schedules: {
      count: data.schedules.length,
      importedPaused: true,
      resumeOldRuns: false,
    },
  };
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
async function assertOldLauncherStopped(target) {
  for (const root of [target, path.dirname(target)]) {
    const receipt = await optional(
      path.join(root, "logs", "preview", "launch.json"),
      JSON.parse,
      null,
    );
    if (
      !receipt ||
      ![path.resolve(root), path.resolve(root, "backend")].includes(
        path.resolve(target),
      )
    )
      continue;
    if (
      [receipt.launcherPid, receipt.runtimePid, receipt.desktopPid].some(alive)
    )
      throw Object.assign(fail("target_profile_is_running"), {
        code: "PROFILE_IN_USE",
      });
  }
}
function metadata(database, archiveId, importedAt) {
  const columns = database
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .map((row) => row.name);
  const archiveColumn = columns.includes("archived_at")
    ? "archived_at"
    : "NULL AS archived_at";
  return database
    .prepare(
      `SELECT id,name,working_dir,session_type,created_at,updated_at,${archiveColumn},(SELECT COUNT(*) FROM messages WHERE session_id=sessions.id) AS message_count FROM sessions WHERE session_type IN ('user','code_pro') ORDER BY updated_at DESC`,
    )
    .all()
    .map((row) => {
      const createdAt = stamp(row.created_at, importedAt);
      return {
        id: `legacy-${hash(`${archiveId}\0${row.id}`).slice(0, 32)}`,
        title: row.name?.trim() || "Imported history",
        cwd: row.working_dir,
        type: row.session_type,
        createdAt,
        updatedAt: stamp(row.updated_at, createdAt),
        archivedAt: row.archived_at ? stamp(row.archived_at, null) : null,
        readonlyHistory: true,
        importedAt,
        legacyHistory: { archiveId, sessionId: row.id },
        updates: [],
        usageUpdates: [],
        messageCount: row.message_count,
      };
    });
}

async function createArchive(data, target) {
  const archiveId = identity(data.source);
  const root = path.join(target, "legacy");
  const destination = path.join(root, archiveId);
  await noLinks(destination);
  const existing = await optional(
    path.join(destination, "manifest.json"),
    JSON.parse,
    null,
  );
  if (existing) {
    if (
      existing.version !== 1 ||
      existing.archiveId !== archiveId ||
      existing.source !== data.source
    )
      throw fail("legacy_archive_conflict");
    return { archiveId, directory: destination, manifest: existing };
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staged = path.join(root, `.migration-${randomUUID()}`);
  await mkdir(staged, { mode: 0o700 });
  let source;
  try {
    const sourceFile = path.join(data.source, "sessions", "sessions.db");
    await noLinks(sourceFile);
    source = openDatabase(sourceFile);
    await backup(source, path.join(staged, "sessions.db"));
    await chmod(path.join(staged, "sessions.db"), 0o600);
    source.close();
    source = null;
    const snapshot = openDatabase(path.join(staged, "sessions.db"));
    let summary;
    try {
      if (snapshot.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw fail("legacy_snapshot_integrity_failed");
      summary = databaseSummary(snapshot);
    } finally {
      snapshot.close();
    }
    await mkdir(path.join(staged, "memory"));
    for (const entry of data.memories)
      await writeFile(
        path.join(staged, "memory", `${entry.identity}.json`),
        JSON.stringify(entry.value),
        { flag: "wx", mode: 0o600 },
      );
    const manifest = {
      version: 1,
      archiveId,
      source: data.source,
      createdAt: new Date().toISOString(),
      history: summary,
      memoryIdentities: data.memories.map((item) => item.identity),
    };
    await writeFile(
      path.join(staged, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await rename(staged, destination);
    return { archiveId, directory: destination, manifest };
  } finally {
    source?.close();
    if (
      path.dirname(staged) !== root ||
      !path.basename(staged).startsWith(".migration-")
    )
      throw fail("migration_cleanup_scope");
    await noLinks(staged);
    await rm(staged, { recursive: true, force: true });
  }
}

function importedProvider(old, archiveId) {
  const engine = ["openai", "openai_compatible"].includes(old.engine)
    ? "openai_compatible"
    : ["ollama", "ollama_compatible"].includes(old.engine)
      ? "ollama_compatible"
      : null;
  if (
    !engine ||
    typeof old.name !== "string" ||
    typeof old.base_url !== "string"
  )
    throw fail("unsupported_legacy_provider");
  const provider = {
    id: `legacy_${hash(`${archiveId}\0${old.name}`).slice(0, 24)}`,
    engine,
    displayName: old.display_name || old.name,
    apiUrl: old.base_url,
    basePath: old.base_path ?? null,
    requiresAuth: old.requires_auth ?? true,
    models: (old.models ?? [])
      .map((item) => (typeof item === "string" ? item : item.name))
      .filter((item) => typeof item === "string"),
    supportsStreaming: old.supports_streaming ?? true,
    catalogProviderId: old.catalog_provider_id ?? null,
    preservesThinking: old.preserves_thinking ?? false,
    secret: null,
    legacyProviderId: old.name,
  };
  modelBase(provider);
  if (
    old.headers != null &&
    (!record(old.headers) ||
      Object.values(old.headers).some((value) => typeof value !== "string"))
  )
    throw fail("invalid_legacy_provider_headers");
  return provider;
}
async function migrateConfiguration(store, data, archiveId, report) {
  const additions = [];
  for (const entry of data.providers) {
    try {
      const provider = importedProvider(entry.value, archiveId);
      const existing = store.read().providers;
      if (
        existing.some(
          (row) =>
            row.id === provider.id ||
            (row.engine === provider.engine &&
              modelBase(row) === modelBase(provider)),
        )
      ) {
        report.providers.skipped++;
        continue;
      }
      provider.headersProtected =
        entry.value.headers && Object.keys(entry.value.headers).length
          ? await protectSecret(JSON.stringify(entry.value.headers))
          : null;
      additions.push(provider);
      if (provider.requiresAuth)
        report.providers.credentialsRequireReentry.push(provider.id);
    } catch {
      report.warnings.push({
        area: "provider",
        file: entry.file,
        reason: "unsupported_or_invalid_provider",
      });
    }
  }
  const preferenceValues = {};
  for (const [oldKey, newKey] of Object.entries(preferences))
    if (data.config[oldKey] !== undefined) {
      try {
        validatePreference(newKey, data.config[oldKey]);
        preferenceValues[newKey] = data.config[oldKey];
      } catch {
        report.warnings.push({
          area: "preference",
          key: oldKey,
          reason: "invalid_preference",
        });
      }
    }
  const extensions = [];
  for (const [key, value] of Object.entries(data.config.extensions ?? {})) {
    if (store.read().extensions.some((row) => row.configKey === key)) {
      report.extensions.skipped++;
      continue;
    }
    try {
      if (!record(value) || !/^[a-z0-9_-]+$/u.test(key))
        throw fail("invalid_legacy_extension");
      if (
        ["builtin", "platform"].includes(value.type) &&
        !builtinNames.has(value.name)
      )
        throw fail("unsupported_legacy_builtin");
      const extension = recipeExtensions([value])[0];
      extensions.push({
        configKey: key,
        enabled: false,
        ...(extension.type === "mcp"
          ? { protected: await protectSecret(JSON.stringify(extension)) }
          : { extension }),
      });
    } catch {
      report.warnings.push({
        area: "extension",
        key,
        reason: "unsupported_or_invalid_extension",
      });
    }
  }
  await store.update((state) => {
    for (const provider of additions)
      if (!state.providers.some((row) => row.id === provider.id)) {
        state.providers.push(provider);
        report.providers.added++;
      }
    state.preferences ??= {};
    for (const [key, value] of Object.entries(preferenceValues))
      if (state.preferences[key] === undefined) state.preferences[key] = value;
    for (const extension of extensions)
      if (
        !state.extensions.some((row) => row.configKey === extension.configKey)
      ) {
        state.extensions.push(extension);
        report.extensions.added++;
      }
  });
}

async function migrateSchedules(store, data, archiveId, report) {
  const schedules = new ScheduleService(store, { timers: false });
  try {
    for (const old of data.schedules) {
      const id = `Legacy ${String(old.id ?? "task")
        .replace(/[\\/\0]/gu, " ")
        .slice(0, 70)} ${hash(`${archiveId}\0${old.id}`).slice(0, 10)}`;
      if ((store.read().schedules ?? []).some((row) => row.id === id)) {
        report.schedules.skipped++;
        continue;
      }
      try {
        if (typeof old.source !== "string") throw fail("missing_legacy_recipe");
        const source = path.isAbsolute(old.source)
          ? path.resolve(old.source)
          : path.resolve(data.source, old.source);
        if (!within(data.source, source))
          throw fail("recipe_outside_legacy_profile");
        const recipe = yaml(await readBounded(source, 1024 * 1024));
        const values = new Map(old.parameters ?? []);
        if (recipe.parameters)
          recipe.parameters = recipe.parameters.map((parameter) =>
            values.has(parameter.key)
              ? { ...parameter, default: values.get(parameter.key) }
              : parameter,
          );
        await schedules.create({
          id,
          recipe,
          cron: old.cron,
          workspaceMode: ["code", "codepro"].includes(old.workspace_mode)
            ? old.workspace_mode
            : "codepro",
          paused: true,
        });
        report.schedules.added++;
      } catch (error) {
        report.warnings.push({
          area: "schedule",
          id,
          reason: error.reason ?? "unsupported_or_invalid_schedule",
        });
      }
    }
  } finally {
    await schedules.close();
  }
}

function memoryRecord(old, archiveId, projectIdentity) {
  if (
    !record(old) ||
    typeof old.id !== "string" ||
    typeof old.content !== "string" ||
    !old.content.trim() ||
    old.content.length > 2000 ||
    typeof old.subject !== "string" ||
    old.subject.length > 120 ||
    !["candidate", "active", "disabled"].includes(old.status) ||
    !["project", "user"].includes(old.scope)
  )
    throw fail("invalid_legacy_memory_record");
  const createdAt = stamp(old.created_at, null),
    updatedAt = stamp(old.updated_at, createdAt);
  if (!createdAt || !updatedAt) throw fail("invalid_legacy_memory_timestamp");
  // Old user-wide memories stay in the archive; never silently broaden scope.
  if (old.scope !== "project")
    throw fail("legacy_user_memory_scope_requires_review");
  return {
    id: `legacy-${hash(`${archiveId}\0${projectIdentity}\0${old.id}`).slice(0, 32)}`,
    kind: old.kind,
    subject: old.subject,
    content: old.content,
    scope: "project",
    source: "legacy",
    status: old.status,
    reason: old.reason || "Imported from the previous profile",
    sourceRef: old.source_ref ?? null,
    confidence: old.confidence,
    createdAt,
    updatedAt,
    lastVerifiedAt: old.last_verified_at ?? null,
    expiresAt: old.expires_at ?? null,
  };
}
async function migrateMemory(archive, projectMap, driverFactory, report) {
  const mappings = archive.manifest.memoryIdentities.filter(
    (id) => projectMap[id],
  );
  report.memory.unmappedIdentities = archive.manifest.memoryIdentities.filter(
    (id) => !projectMap[id],
  );
  if (!mappings.length) return;
  const driver = await driverFactory();
  try {
    const memory = new ProjectMemory(driver);
    for (const projectIdentity of mappings) {
      try {
        const scope = await memory.scope(projectMap[projectIdentity]);
        const document = JSON.parse(
          await readBounded(
            path.join(archive.directory, "memory", `${projectIdentity}.json`),
          ),
        );
        const existing = await driver.memory.list(scope);
        let bytes = Buffer.byteLength(JSON.stringify(existing));
        for (const old of document.entries) {
          try {
            const item = memoryRecord(old, archive.archiveId, projectIdentity);
            if (await driver.memory.get(scope, `record:${item.id}`)) {
              report.memory.skipped++;
              continue;
            }
            bytes += Buffer.byteLength(JSON.stringify(item));
            if (bytes > 8 * 1024 * 1024) throw fail("memory_scope_limit");
            await driver.memory.set(scope, `record:${item.id}`, item);
            report.memory.added++;
          } catch (error) {
            report.warnings.push({
              area: "memory",
              projectIdentity,
              reason: error.reason ?? "invalid_memory_record",
            });
          }
        }
      } catch (error) {
        report.warnings.push({
          area: "memory",
          projectIdentity,
          reason: error.reason ?? "project_mapping_unavailable",
        });
      }
    }
  } finally {
    await driver.close();
  }
}

/** Caller must stop the target runtime. The same SQLite lease guards startup. */
export async function migrateLegacyProfile({
  sourceDir,
  targetDir,
  projectMap = {},
  offline = false,
  driverFactory,
} = {}) {
  if (!offline) throw fail("offline_migration_required");
  if (typeof targetDir !== "string" || !path.isAbsolute(targetDir))
    throw fail("absolute_target_required");
  const data = await sourceData(sourceDir);
  const target = path.resolve(targetDir);
  if (
    path.relative(target, data.source) === "" ||
    within(data.source, target) ||
    within(target, data.source)
  )
    throw fail("source_target_overlap");
  await noLinks(target);
  await assertOldLauncherStopped(target);
  const lease = await acquireProfileLock(target);
  try {
    await assertOldLauncherStopped(target);
    const store = await openStore(target);
    const archive = await createArchive(data, target);
    const report = {
      version: 1,
      mode: "apply",
      archiveId: archive.archiveId,
      history: { added: 0, skipped: 0 },
      providers: { added: 0, skipped: 0, credentialsRequireReentry: [] },
      extensions: { added: 0, skipped: 0, importedEnabled: false },
      schedules: { added: 0, skipped: 0, paused: true },
      memory: { added: 0, skipped: 0, unmappedIdentities: [] },
      warnings: [],
    };
    const database = openDatabase(path.join(archive.directory, "sessions.db"));
    let sessions;
    try {
      sessions = metadata(
        database,
        archive.archiveId,
        archive.manifest.createdAt,
      );
    } finally {
      database.close();
    }
    await store.update((state) => {
      for (const session of sessions) {
        if (state.sessions.some((row) => row.id === session.id)) {
          report.history.skipped++;
          continue;
        }
        state.sessions.push(session);
        report.history.added++;
      }
    });
    await migrateConfiguration(store, data, archive.archiveId, report);
    await migrateSchedules(store, data, archive.archiveId, report);
    await migrateMemory(
      archive,
      projectMap,
      driverFactory ??
        (async () => {
          const { createHarnessDriver } = await import("./harness/index.mjs");
          return createHarnessDriver({
            dataDir: path.join(target, "harness"),
            instructionsHome: path.dirname(target),
          });
        }),
      report,
    );
    await store.update((state) => {
      state.legacyMigrations ??= {};
      state.legacyMigrations[archive.archiveId] = {
        ...report,
        completedAt: new Date().toISOString(),
      };
    });
    await store.flush();
    await writeFile(
      path.join(archive.directory, "migration-report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    return report;
  } finally {
    lease.close();
  }
}

/** Read a single selected conversation from the immutable destination snapshot. */
export async function loadLegacyConversation(dataDir, reference) {
  if (
    !reference ||
    !/^legacy-[0-9a-f]{24}$/u.test(reference.archiveId) ||
    typeof reference.sessionId !== "string"
  )
    throw fail("invalid_legacy_history_reference");
  const file = path.join(dataDir, "legacy", reference.archiveId, "sessions.db");
  await noLinks(file);
  const database = openDatabase(file);
  try {
    const selected = database
      .prepare(
        "SELECT id FROM sessions WHERE id=? AND session_type IN ('user','code_pro')",
      )
      .get(reference.sessionId);
    if (!selected) throw fail("legacy_session_not_found");
    const rows = database
      .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY id")
      .iterate(reference.sessionId);
    const conversation = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += Buffer.byteLength(row.content_json);
      if (bytes > 256 * 1024 * 1024)
        throw fail("legacy_conversation_size_limit");
      const message = {
        id: row.message_id || `legacy-message-${row.id}`,
        role: row.role,
        created: row.created_timestamp,
        content: JSON.parse(row.content_json),
        metadata: row.metadata_json
          ? JSON.parse(row.metadata_json)
          : { userVisible: true, agentVisible: true },
      };
      validateConversation([message]);
      conversation.push(message);
    }
    return conversation;
  } finally {
    database.close();
  }
}
