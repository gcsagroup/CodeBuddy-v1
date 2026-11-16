import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const LEASE_PREFIX = "_goose/unstable/workspace/lease/";
const SOURCE_PREFIX = "_goose/unstable/sources/";
const FOLDER_PREFIX = "_codebuddy/project-folders/";
const CONFIRMABLE_STATES = new Set([
  "missing",
  "empty-directory",
  "non-empty-directory",
]);

function invalid(message, code = "workspace_identity_unavailable") {
  return Object.assign(new Error(message), { code: -32602, data: { code } });
}

export function workspaceIdentity(value) {
  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(value)) {
    const normalized = value.replaceAll("/", "\\");
    return (normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized)
      .replace(/\\+$/u, "")
      .toLowerCase();
  }
  return path.posix.normalize(value).replace(/(?<!^)\/+$/u, "");
}

function absoluteDirectory(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw invalid("Workspace path must be absolute");
  }
  const normalized = path.normalize(value);
  if (
    workspaceIdentity(normalized) ===
    workspaceIdentity(path.parse(normalized).root)
  ) {
    throw invalid("A filesystem root is not a writable project");
  }
  return normalized;
}

// The registry owns capability lifetime; filesystem observations are renewed at
// acquisition, consumption and prompt entry. These are not native directory
// handles, and must not be advertised as an OS sandbox or rename lock.
async function directorySnapshot(directory) {
  const ancestors = [];
  for (let current = directory; ; current = path.dirname(current)) {
    ancestors.push(current);
    if (path.dirname(current) === current) break;
  }
  // Every ancestor is still checked on each entry. Independent filesystem reads
  // need not serialize their latency, especially for deep Windows project paths.
  const [canonical, chain] = await Promise.all([
    realpath(directory),
    Promise.all(ancestors.map(async current => {
      const stats = await lstat(current, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw invalid("Workspace ancestry contains a link or a non-directory");
      return { path: current, dev: String(stats.dev), ino: String(stats.ino), birthtime: String(stats.birthtimeNs) };
    })),
  ]);
  return { canonical, identity: workspaceIdentity(canonical), chain };
}

function sameSnapshot(left, right) {
  return (
    left.identity === right.identity &&
    JSON.stringify(left.chain) === JSON.stringify(right.chain)
  );
}

function insideDirectory(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function publicLease(lease) {
  return {
    leaseId: lease.id,
    workingDir: lease.snapshot.canonical,
    normalizedIdentity: lease.snapshot.identity,
    created: lease.created,
  };
}

export class WorkspaceService {
  constructor(
    store,
    { now = Date.now, leaseLifetimeMs = 300_000, projectDirectory } = {},
  ) {
    this.projectDirectory =
      projectDirectory ??
      (store.directory ? path.join(store.directory, "projects") : null);
    this.now = now;
    this.leaseLifetimeMs = leaseLifetimeMs;
    this.pending = new Map();
    this.sessions = new Map();
    this.tail = Promise.resolve();
  }

  serial(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  handles(method, params = {}) {
    if ([FOLDER_PREFIX + 'get', FOLDER_PREFIX + 'save'].includes(method)) return true;
    if (method === SOURCE_PREFIX + "import") {
      try {
        return JSON.parse(params.data)?.type === "project";
      } catch {
        return false;
      }
    }
    return (
      [LEASE_PREFIX + "acquire", LEASE_PREFIX + "release"].includes(method) ||
      (params.type === "project" &&
        ["list", "create", "update", "delete", "export"].some(
          (action) => method === SOURCE_PREFIX + action,
        ))
    );
  }

  async request(method, params, connection) {
    if (method === FOLDER_PREFIX + 'get') return this.projectFolders(params.cwd);
    if (method === FOLDER_PREFIX + 'save') return this.saveProjectFolders(params);
    if (method === LEASE_PREFIX + "acquire")
      return this.acquire(params, connection);
    if (method === LEASE_PREFIX + "release")
      return this.release(params.leaseId, connection);
    if (method === SOURCE_PREFIX + "import" && this.handles(method, params))
      return this.importProject(params);
    if (this.handles(method, params))
      return this.projectRequest(method.slice(SOURCE_PREFIX.length), params);
    throw invalid("Unsupported workspace method");
  }

  folderConfigPath(cwd) {
    const key = createHash('sha256').update(workspaceIdentity(path.resolve(cwd))).digest('hex');
    return path.join(this.projectDirectory, 'linked-folders', key + '.json');
  }

  async readFolderConfig(cwd) {
    if (!this.projectDirectory || !cwd || !path.isAbsolute(cwd)) return null;
    try { return JSON.parse(await readFile(this.folderConfigPath(cwd), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async projectFolders(cwd) {
    const config = await this.readFolderConfig(cwd);
    return { version: config?.version ?? '', folders: (config?.folders ?? []).map(({ path, access }) => ({ path, access })) };
  }

  saveProjectFolders({ cwd, folders, version }) {
    return this.serial(async () => {
      const main = await directorySnapshot(absoluteDirectory(cwd));
      const current = await this.readFolderConfig(cwd);
      if ((current?.version ?? '') !== version) throw invalid('Project settings changed. Reopen the editor.');
      if (!Array.isArray(folders)) throw invalid('Expected a list of folders');
      const roots = [main.canonical];
      const entries = [];
      for (const item of folders) {
        if (!['reference', 'write'].includes(item?.access)) throw invalid('Invalid folder access');
        const snapshot = await directorySnapshot(absoluteDirectory(item.path));
        if (roots.some(root => insideDirectory(root, snapshot.canonical) || insideDirectory(snapshot.canonical, root)))
          throw invalid('Choose separate folders. These project folders overlap.');
        roots.push(snapshot.canonical);
        entries.push({ path: snapshot.canonical, access: item.access, snapshot });
      }
      const file = this.folderConfigPath(cwd);
      await mkdir(path.dirname(file), { recursive: true });
      const next = { version: randomUUID(), main, folders: entries };
      const temporary = file + '.' + next.version + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return this.projectFolders(cwd);
    });
  }

  async linkedWriteAccess(cwd, target) {
    const config = await this.readFolderConfig(cwd);
    const entry = config?.folders.find(item => insideDirectory(item.path, target.targetKey) || insideDirectory(item.path, target.displayPath));
    if (!entry) return undefined;
    if (entry.access !== 'write' || !insideDirectory(entry.path, target.targetKey)) return false;
    // A directory replaced or redirected since selection must be reselected.
    if (!sameSnapshot(config.main, await directorySnapshot(cwd)) ||
        !sameSnapshot(entry.snapshot, await directorySnapshot(entry.path))) return false;
    return entry.path;
  }

  async discard(lease) {
    this.pending.delete(lease.id);
    if (!lease.created) return;
    try {
      if (
        sameSnapshot(
          lease.snapshot,
          await directorySnapshot(lease.snapshot.canonical),
        )
      ) {
        // Never recursively remove anything. A task/user write keeps the folder.
        await rmdir(lease.snapshot.canonical);
      }
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }

  async prune() {
    for (const lease of this.pending.values()) {
      if (lease.expiresAt <= this.now()) await this.discard(lease);
    }
  }

  acquire(input, connection) {
    return this.serial(async () => {
      await this.prune();
      if (
        !connection ||
        !CONFIRMABLE_STATES.has(input.expectedState) ||
        typeof input.expectedIdentity !== "string"
      ) {
        throw invalid("Workspace state, identity and connection are required");
      }
      const requested = absoluteDirectory(input.requestedPath);
      let created = false;
      let snapshot;
      if (input.expectedState === "missing") {
        // Default allocation is a direct child of an existing canonical root.
        // No recursive mkdir: an existing target is a conflict, never reused.
        const parent = await directorySnapshot(path.dirname(requested));
        const planned = path.join(parent.canonical, path.basename(requested));
        if (workspaceIdentity(planned) !== input.expectedIdentity)
          throw invalid("Workspace changed since inspection");
        try {
          await mkdir(planned);
        } catch (error) {
          if (error.code === "EEXIST")
            throw invalid("Workspace changed since inspection");
          throw error;
        }
        created = true;
        snapshot = await directorySnapshot(planned);
        if (
          !sameSnapshot(parent, await directorySnapshot(path.dirname(planned)))
        )
          throw invalid("Workspace parent changed during creation");
      } else {
        snapshot = await directorySnapshot(requested);
      }
      if (snapshot.identity !== input.expectedIdentity)
        throw invalid("Workspace changed since inspection");
      const entries = await readdir(snapshot.canonical);
      const expectedEmpty =
        created || input.expectedState === "empty-directory";
      if ((entries.length === 0) !== expectedEmpty)
        throw invalid("Workspace changed since inspection");
      if (!sameSnapshot(snapshot, await directorySnapshot(snapshot.canonical)))
        throw invalid("Workspace changed during acquisition");
      const lease = {
        id: randomUUID(),
        snapshot,
        created,
        connection,
        expiresAt: this.now() + this.leaseLifetimeMs,
        expectedEmpty,
      };
      this.pending.set(lease.id, lease);
      return publicLease(lease);
    });
  }

  consumeLease({ leaseId, cwd, sessionId }, connection) {
    return this.serial(async () => {
      await this.prune();
      const lease = this.pending.get(leaseId);
      if (
        !lease ||
        lease.connection !== connection ||
        typeof sessionId !== "string" ||
        !sessionId
      )
        throw invalid(
          "Workspace lease is expired, consumed or belongs to another connection",
        );
      if (workspaceIdentity(absoluteDirectory(cwd)) !== lease.snapshot.identity)
        throw invalid("Session workspace does not match its lease");
      const snapshot = await directorySnapshot(cwd);
      if (!sameSnapshot(lease.snapshot, snapshot))
        throw invalid("Workspace changed since confirmation");
      const entries = await readdir(snapshot.canonical);
      if ((entries.length === 0) !== lease.expectedEmpty)
        throw invalid("Workspace contents changed since confirmation");
      this.pending.delete(lease.id);
      this.sessions.set(sessionId, lease);
      return publicLease(lease);
    });
  }

  changeSessionDirectory(sessionId, cwd, operation) {
    return this.serial(async () => {
      const snapshot = await directorySnapshot(absoluteDirectory(cwd));
      const result = await operation();
      // Only a successful native rebind replaces the previous workspace lease.
      this.sessions.set(sessionId, { id: randomUUID(), snapshot, created: false, expectedEmpty: false });
      return result;
    });
  }

  validateSession(sessionId, cwd, { initialContents = false } = {}) {
    return this.serial(async () => {
      const lease = this.sessions.get(sessionId);
      if (!lease)
        throw invalid(
          "The project workspace must be confirmed again after restart",
        );
      if (
        workspaceIdentity(absoluteDirectory(cwd)) !== lease.snapshot.identity ||
        !sameSnapshot(lease.snapshot, await directorySnapshot(cwd))
      ) {
        throw invalid(
          "The session workspace changed; confirm the project again",
        );
      }
      if (
        initialContents &&
        ((await readdir(cwd)).length === 0) !== lease.expectedEmpty
      )
        throw invalid("Workspace contents changed since confirmation");
      return publicLease(lease);
    });
  }

  release(leaseId, connection) {
    return this.serial(async () => {
      const lease = this.pending.get(leaseId);
      if (lease && lease.connection !== connection)
        throw invalid("Workspace lease belongs to another connection");
      if (lease) await this.discard(lease);
      return {};
    });
  }

  releaseSession(sessionId, { discardUnused = false } = {}) {
    return this.serial(async () => {
      const lease = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      // Failed creation may reclaim its own untouched, still-empty allocation.
      // Existing folders and any directory with user/task content are retained.
      if (discardUnused && lease) await this.discard(lease);
    });
  }

  disconnect(connection) {
    return this.serial(async () => {
      for (const lease of this.pending.values())
        if (lease.connection === connection) await this.discard(lease);
    });
  }

  close() {
    return this.serial(async () => {
      for (const lease of this.pending.values()) await this.discard(lease);
      this.sessions.clear();
    });
  }

  async readProject(file) {
    const raw = await readFile(file, "utf8");
    const end = raw.indexOf("\n---\n", 4);
    if (!raw.startsWith("---\n") || end < 0)
      throw invalid("Invalid project metadata");
    // JSON is a YAML subset, so these remain ordinary Markdown source files.
    const metadata = JSON.parse(raw.slice(4, end));
    const { name, description, ...properties } = metadata;
    return {
      type: "project",
      name,
      description,
      content: raw.slice(end + 5).replace(/^\n/u, ""),
      path: file,
      global: true,
      writable: true,
      supportingFiles: [],
      properties,
    };
  }

  async listProjects() {
    if (!this.projectDirectory)
      throw invalid("The project metadata directory is not configured");
    await mkdir(this.projectDirectory, { recursive: true });
    const entries = await readdir(this.projectDirectory, {
      withFileTypes: true,
    });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) =>
          this.readProject(path.join(this.projectDirectory, entry.name)),
        ),
    );
  }

  createManagedProject(root, folder, title, projectId, { reuseDirectory = false } = {}) {
    return this.serial(async () => {
      const parent = await directorySnapshot(absoluteDirectory(root));
      const cwd = path.join(parent.canonical, folder);
      if (path.dirname(cwd) !== parent.canonical || !/^[^<>:"/\\|?*\x00-\x1f]+$/u.test(folder) ||
          /[. ]$/u.test(folder) || /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(folder))
        throw invalid('Choose a single valid folder name');
      const identity = workspaceIdentity(cwd);
      const projects = await this.listProjects();
      const existing = projects.find(item => item.properties.codeproWorkspaceIdentity === identity);
      if (existing) {
        if (existing.properties.title !== title) throw invalid('The folder is already registered under another title');
        await directorySnapshot(cwd);
        return existing;
      }
      if (!reuseDirectory) await mkdir(cwd);
      let snapshot;
      try {
        snapshot = await directorySnapshot(cwd);
        if (!sameSnapshot(parent, await directorySnapshot(root))) throw invalid('Workspace root changed');
        return (await this.writeProject('create', {
          name: projectId, description: '', content: '', target: { scope: 'global' },
          properties: { title, workingDirs: [snapshot.canonical], codeproWorkspaceIdentity: identity },
        }, projects)).source;
      } catch (error) {
        if (snapshot && !reuseDirectory) await this.discard({ snapshot, created: true });
        throw error;
      }
    });
  }

  async resolveProjectDirectory(projectId, explicitDirectory) {
    if (typeof projectId !== "string" || !projectId)
      throw invalid("A project id is required", "project_not_found");
    const project = (await this.listProjects()).find(
      (entry) => entry.name === projectId,
    );
    if (!project)
      throw invalid("Project source was not found", "project_not_found");
    const directories = project.properties?.workingDirs;
    if (!Array.isArray(directories) || !directories.length)
      throw invalid(
        "The project has no configured working directory",
        "project_directory_required",
      );
    const unique = [
      ...new Map(
        directories.map((directory) => {
          const value = absoluteDirectory(directory);
          return [workspaceIdentity(value), value];
        }),
      ).values(),
    ];
    let selected = unique[0];
    if (explicitDirectory) {
      const identity = workspaceIdentity(absoluteDirectory(explicitDirectory));
      selected = unique.find(
        (directory) => workspaceIdentity(directory) === identity,
      );
      if (!selected)
        throw invalid(
          "The requested directory does not belong to this project",
          "source_scope_mismatch",
        );
    } else if (unique.length !== 1) {
      throw invalid(
        "Choose a directory for this multi-directory project",
        "project_directory_required",
      );
    }
    return (await directorySnapshot(selected)).canonical;
  }

  projectRequest(action, input, approvedProject) {
    return this.serial(async () => {
      const projects = await this.listProjects();
      if (approvedProject && JSON.stringify(projects.find(p => p.path === input.path)) !== JSON.stringify(approvedProject))
        throw invalid('Project changed during approval');
      return this.writeProject(action, input, projects);
    });
  }

  async writeProject(action, input, projects) {
      if (action === "list") return { sources: projects };
      const existing = projects.find((entry) => entry.path === input.path);
      if (action === "export") {
        if (!existing) throw invalid("Project source was not found");
        return {
          json: JSON.stringify(
            {
              version: 1,
              type: "project",
              name: existing.name,
              title: existing.properties.title ?? existing.name,
              description: existing.description,
              content: existing.content,
              properties: existing.properties,
            },
            null,
            2,
          ),
          filename: `${existing.name}.project.json`,
        };
      }
      if (action === "delete") {
        if (!existing) throw invalid("Project source was not found");
        await unlink(existing.path);
        return {};
      }
      if (action !== "create" && action !== "update")
        throw invalid("Unsupported project source operation");
      if (
        typeof input.name !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.name) ||
        input.name.length > 128
      )
        throw invalid("Project name must be a kebab-case identifier");
      if (
        typeof input.description !== "string" ||
        typeof input.content !== "string"
      )
        throw invalid("Project description and content must be strings");
      if (
        input.properties != null &&
        (typeof input.properties !== "object" ||
          Array.isArray(input.properties))
      )
        throw invalid("Project properties must be an object");
      if (action === "create" && input.target?.scope !== "global")
        throw invalid("Projects use global source scope");
      const properties = structuredClone(input.properties ?? {});
      if (properties.workingDirs !== undefined) {
        if (
          !Array.isArray(properties.workingDirs) ||
          properties.workingDirs.some(
            (value) => typeof value !== "string" || !path.isAbsolute(value),
          )
        )
          throw invalid("Project workingDirs must contain absolute paths");
      }
      if (action === "update" && !existing)
        throw invalid("Project source was not found");
      if (
        projects.some(
          (entry) => entry.path !== existing?.path && entry.name === input.name,
        )
      )
        throw invalid("A project with this name already exists");
      const file =
        existing?.path ?? path.join(this.projectDirectory, `${input.name}.md`);
      const metadata = {
        ...(input.properties === undefined && existing
          ? existing.properties
          : properties),
        name: input.name,
        description: input.description,
      };
      const text = `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${input.content}`;
      // Only paths returned by this directory's listing may be mutated. Deleting
      // the metadata never deletes the project or its files.
      if (existing) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        try {
          await rename(temporary, file);
        } finally {
          await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      } else {
        await writeFile(file, text, { mode: 0o600, flag: "wx" });
      }
      return { source: await this.readProject(file) };
  }

  async importProject(input) {
    const value = JSON.parse(input.data);
    if (value.version !== 1 || value.type !== "project")
      throw invalid("Unsupported project export format");
    if (input.target?.scope !== "global")
      throw invalid("Projects use global source scope");
    const existing = (await this.projectRequest("list", {})).sources;
    let name = value.name;
    for (
      let index = 1;
      existing.some((entry) => entry.name === name);
      index++
    ) {
      name = `${value.name}-imported${index === 1 ? "" : `-${index}`}`;
    }
    const { source } = await this.projectRequest("create", {
      type: "project",
      name,
      description: value.description,
      content: value.content,
      target: input.target,
      properties: {
        ...value.properties,
        ...(value.title ? { title: value.title } : {}),
      },
    });
    return { sources: [source] };
  }
}
