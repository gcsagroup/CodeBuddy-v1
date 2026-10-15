import { protectSecret, revealSecret } from "./secrets.mjs";
import path from "node:path";
import { invalid } from "./providers.mjs";

const changedSnapshot = Symbol("extension snapshot changed");

// The host can prepare again before execution when startup synchronizes bundled
// extensions. Keep this internal marker separate from credential/validation errors.
export function extensionSnapshotChanged(message) {
  const error = invalid(message);
  Object.defineProperty(error, changedSnapshot, { value: true });
  return error;
}

export function isExtensionSnapshotChanged(error) {
  return error?.[changedSnapshot] === true;
}

export const extensionName = (e) =>
  typeof e === "string" ? e : e?.type === "mcp" ? e.server?.name : e?.name;
export const extensionConfigKey = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");

export function configuredExtension(configured, name) {
  return configured.some(
    (entry) =>
      entry.name === name ||
      entry.configKey === name ||
      entry.configKey === extensionConfigKey(name),
  );
}

const selectionIdentity = (session) =>
  JSON.stringify([
    session.id,
    session.type,
    session.extensions,
    session.extensionDefinitions,
    session.protectedMcpServers,
    session.mcpServers,
  ]);

// Scope decrypted definitions to one operation. Permission checks share this
// resolved view, while the next operation reads the current settings again.
export async function resolveSessionExtensions(session, settings) {
  const identity = selectionIdentity(session);
  const [snapshot, definitions, servers] = await Promise.all([
    settings.extensionSnapshot
      ? settings.extensionSnapshot()
      : settings.extensions().then((entries) => ({
          configured: entries.map((entry) => ({
            configKey: entry.configKey,
            enabled: entry.enabled,
            name: extensionName(entry.extension),
          })),
          entries: entries.filter((entry) => entry.enabled),
          assertCurrent() {},
        })),
    session.extensionDefinitions
      ? revealSecret(session.extensionDefinitions).then(JSON.parse)
      : (session.extensions ?? []).filter((entry) => typeof entry !== "string"),
    sessionMcpServers(session),
  ]);
  const names = session.extensions?.map(extensionName);
  const selected = snapshot.entries.filter(
    (entry) =>
      !names ||
      names.some((name) =>
        configuredExtension(
          [
            {
              configKey: entry.configKey,
              name: extensionName(entry.extension),
            },
          ],
          name,
        ),
      ),
  );
  for (const extension of definitions) {
    const name = extensionName(extension);
    if (
      !configuredExtension(snapshot.configured, name) &&
      names?.includes(name)
    )
      selected.push({ configKey: name, enabled: true, extension });
  }
  const mcpServers = servers.filter(
    (server) =>
      !configuredExtension(snapshot.configured, server.name) ||
      selected.some((entry) => extensionName(entry.extension) === server.name),
  );
  const assertCurrent = (current) => {
    snapshot.assertCurrent();
    if (selectionIdentity(current) !== identity)
      throw extensionSnapshotChanged(
        "Session extensions changed; retry the operation",
      );
  };
  assertCurrent(session);
  return {
    selected,
    mcpServers,
    configured: snapshot.configured,
    assertCurrent,
  };
}

// Session selections can contain full ACP definitions, including credentials.
// Keep names as ordinary metadata and protect definitions at rest.
export async function sealSessionExtensions(selected, servers = []) {
  if (selected != null && !Array.isArray(selected))
    throw invalid("enabledExtensions must be an array");
  if (!Array.isArray(servers)) throw invalid("mcpServers must be an array");
  const definitions = (selected ?? []).filter((e) => typeof e !== "string");
  if ((selected ?? []).some((e) => !extensionName(e)))
    throw invalid("Extension name is required");
  return {
    extensions:
      selected == null ? null : [...new Set(selected.map(extensionName))],
    extensionDefinitions: definitions.length
      ? await protectSecret(JSON.stringify(definitions))
      : null,
    protectedMcpServers: servers.length
      ? await protectSecret(JSON.stringify(servers))
      : null,
    mcpServers: [],
  };
}

export async function selectedExtensions(session, settings, resolved) {
  const snapshot =
    resolved ?? (await resolveSessionExtensions(session, settings));
  snapshot.assertCurrent(session);
  return snapshot.selected;
}

export async function sessionMcpServers(session) {
  return session.protectedMcpServers
    ? JSON.parse(await revealSecret(session.protectedMcpServers))
    : (session.mcpServers ?? []);
}

export async function activeMcpServers(session, settings, resolved) {
  const snapshot =
    resolved ?? (await resolveSessionExtensions(session, settings));
  snapshot.assertCurrent(session);
  return snapshot.mcpServers;
}

export async function harnessMcpServer(
  extension,
  state,
  cwd,
  environment = {},
) {
  const ext = extension,
    server = ext.server;
  if (!server || typeof server.name !== "string")
    throw invalid("MCP server name is required");
  const resolved = Object.assign(Object.create(null), environment);
  const inline = server.command
    ? []
    : (server._meta?.codebuddyRecipeEnvs ?? []);
  if (!Array.isArray(inline)) throw invalid("Invalid extension environment");
  for (const entry of inline) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
      typeof entry.value !== "string"
    )
      throw invalid("Invalid extension environment");
    resolved[entry.name] = entry.value;
  }
  for (const key of ext.envKeys ?? [])
    if (!Object.hasOwn(resolved, key)) {
      const entry = state.config[key];
      if (entry?.secret) resolved[key] = await revealSecret(entry.secret);
      else if (typeof entry?.value === "string") resolved[key] = entry.value;
    }
  const pattern = server.command
    ? /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
    : /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const expand = (value) =>
    String(value).replace(pattern, (_, braced, simple) => {
      const key = braced ?? simple;
      if (!Object.hasOwn(resolved, key))
        throw invalid("Configure extension environment variable: " + key);
      return resolved[key];
    });
  if (server.command)
    return {
      serverName: server.name,
      transport: "stdio",
      cwd: server._meta?.cwd ? path.resolve(cwd, server._meta.cwd) : cwd,
      command: server.command,
      args: server.args,
      env: {
        ...resolved,
        ...Object.fromEntries(
          (server.env ?? []).map((e) => [e.name, expand(e.value)]),
        ),
      },
    };
  const url = expand(server.url);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("Configure a valid HTTP extension URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw invalid(
      "HTTP extension URL must use HTTP(S) without embedded credentials",
    );
  return {
    serverName: server.name,
    transport: "streamable-http",
    url,
    headers: Object.fromEntries(
      (server.headers ?? []).map((h) => [h.name, expand(h.value)]),
    ),
  };
}
