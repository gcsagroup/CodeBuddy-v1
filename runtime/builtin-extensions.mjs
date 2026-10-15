import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalid } from "./providers.mjs";

const binDirectory = fileURLToPath(new URL("./tools/bin/", import.meta.url));
const artifacts = {
  goose: {
    file: "goose-0a286375/goose.exe",
    bytes: 332407808,
    sha256: "0a286375a8d30f0acbbf38f40275372a13a613dc5b5ad50fae5d0de6b23fa602",
  },
  computer: {
    file: "qwen-computer-use.exe",
    bytes: 4736000,
    sha256: "5b08525ee3825d611a4ef643badbdf15dd55e95816e4f5f15fd06dbe30c5f9b8",
  },
};
const builtins = {
  commonqueries: {
    artifact: artifacts.goose,
    args: ["mcp", "commonqueries"],
    displayName: "时间与天气",
    description: "读取主机时间、解析城市并按设置查询天气。",
    tools: ["time_now", "location_resolve", "weather_get"],
  },
  qwen_computer: {
    artifact: artifacts.computer,
    args: ["--foreground-input", "mcp"],
    displayName: "电脑操作",
    description: "通过独立 MCP 服务读取桌面状态并执行电脑操作。",
    tools: [
      "click",
      "drag",
      "get_app_state",
      "list_apps",
      "perform_secondary_action",
      "press_key",
      "scroll",
      "set_value",
      "type_text",
    ],
  },
  computercontroller: {
    artifact: artifacts.goose,
    args: ["mcp", "computercontroller"],
    displayName: "文档与网页",
    description: "读取和编辑文档、表格、PDF，抓取网页并管理工具缓存。",
    tools: ["cache", "docx_tool", "pdf_tool", "web_scrape", "xlsx_tool"],
  },
  autovisualiser: {
    artifact: artifacts.goose,
    args: ["mcp", "autovisualiser"],
    displayName: "图表可视化",
    description: "生成图表、地图和 Mermaid 图形。",
    tools: [
      "render_chord",
      "render_donut",
      "render_map",
      "render_mermaid",
      "render_radar",
      "render_sankey",
      "render_treemap",
      "show_chart",
    ],
  },
};
const verified = new Map();
const normalizePath = (value) =>
  process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);

export function isBuiltinMcp(extension) {
  return (
    (extension?.type === "builtin" || (extension?.type === "platform" && extension.name === "commonqueries")) && Object.hasOwn(builtins, extension.name)
  );
}

export function builtinToolNames(name) {
  return Object.hasOwn(builtins, name) ? [...builtins[name].tools] : [];
}

async function verifiedBinary(artifact) {
  const file = path.join(binDirectory, artifact.file);
  const info = await lstat(file, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== BigInt(artifact.bytes) ||
    normalizePath(await realpath(file)) !== normalizePath(file)
  ) {
    throw invalid(`Bundled MCP artifact identity is invalid: ${artifact.file}`);
  }
  const signature = [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":");
  const cached = verified.get(file);
  if (cached?.signature === signature) return cached.promise;
  const promise = (async () => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    if (hash.digest("hex") !== artifact.sha256)
      throw invalid(`Bundled MCP artifact checksum differs: ${artifact.file}`);
    const current = await lstat(file, { bigint: true });
    if (
      [
        current.dev,
        current.ino,
        current.size,
        current.mtimeNs,
        current.ctimeNs,
      ].join(":") !== signature
    )
      throw invalid(
        `Bundled MCP artifact changed during verification: ${artifact.file}`,
      );
    return file;
  })();
  verified.set(file, { signature, promise });
  try {
    return await promise;
  } catch (error) {
    verified.delete(file);
    throw error;
  }
}

/** Availability is artifact validation, not a live MCP tools/list result. */
export async function listAvailableBuiltins({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return Promise.all(
    Object.entries(builtins).map(async ([name, entry]) => {
      let reason;
      if (platform !== "win32" || arch !== "x64")
        reason = `Bundled MCP artifact has not been supplied for ${platform}/${arch}`;
      else
        try {
          await verifiedBinary(entry.artifact);
        } catch (error) {
          reason = error.message;
        }
      return {
        configKey: name,
        enabled: false,
        available: !reason,
        ...(reason ? { reason } : {}),
        extension: {
          type: "builtin",
          name,
          display_name: entry.displayName,
          description: entry.description,
          bundled: true,
        },
      };
    }),
  );
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw invalid(`${label} must be an absolute directory`);
  const info = await lstat(value);
  const canonical = await realpath(value);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    normalizePath(canonical) !== normalizePath(value)
  )
    throw invalid(`${label} must be a real directory without symbolic links`);
  return canonical;
}

async function privateDirectory(parent, name) {
  const target = path.join(parent, name);
  await mkdir(target, { recursive: true });
  return canonicalDirectory(target, "Tool runtime directory");
}

async function toolEnvironment(dataDir, name) {
  const dataRoot = await canonicalDirectory(dataDir, "Runtime dataDir");
  const toolRoot = await privateDirectory(
    await privateDirectory(dataRoot, "tool-runtime"),
    name,
  );
  const directories = {};
  for (const leaf of [
    "home",
    "profile",
    "cache",
    "temp",
    "roaming",
    "local",
    "config",
    "data",
    "state",
    "runtime",
  ]) {
    directories[leaf] = await privateDirectory(toolRoot, leaf);
  }
  // Harness merges these overrides over its scrubbed ambient environment. Clear
  // legacy storage overrides so another installed copy cannot own this child.
  const env = Object.fromEntries(
    Object.keys(process.env)
      .filter(
        (key) =>
          /^(?:CODEBUDDY_|CODEAGENTPRO_|GOOSE_|LANGFUSE_|OTEL_)/iu.test(key) &&
          !/KEY|PASSWORD|SECRET|TOKEN/iu.test(key),
      )
      .map((key) => [key, ""]),
  );
  Object.assign(env, {
    HOME: directories.home,
    USERPROFILE: directories.home,
    HOMEDRIVE: path.parse(directories.home).root.replace(/[\\/]$/u, ""),
    HOMEPATH: directories.home.slice(
      path.parse(directories.home).root.length - 1,
    ),
    APPDATA: directories.roaming,
    LOCALAPPDATA: directories.local,
    TEMP: directories.temp,
    TMP: directories.temp,
    TMPDIR: directories.temp,
    XDG_CACHE_HOME: directories.cache,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_STATE_HOME: directories.state,
    XDG_RUNTIME_DIR: directories.runtime,
    CODEBUDDY_HOME: directories.profile,
    CODEAGENTPRO_HOME: directories.profile,
    GOOSE_PATH_ROOT: directories.profile,
    GOOSE_DISABLE_KEYRING: "true",
    GOOSE_TELEMETRY_OFF: "1",
    OTEL_SDK_DISABLED: "true",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    DO_NOT_TRACK: "1",
    RUST_LOG: "error",
  });
  // Windows treats environment names as case-insensitive. Avoid inherited aliases
  // overriding a canonical value when a client library serializes the map.
  for (const key of Object.keys(process.env))
    if (Object.hasOwn(env, key.toUpperCase()))
      env[key] = env[key.toUpperCase()];
  return env;
}

/** The only permitted legacy entrypoints here are standalone stdio MCP tools. */
export async function builtinMcp(extension, { cwd, dataDir } = {}) {
  if (!isBuiltinMcp(extension)) return undefined;
  if (process.platform !== "win32" || process.arch !== "x64")
    throw invalid(
      `Builtin MCP ${extension.name} is awaiting an artifact for ${process.platform}/${process.arch}`,
    );
  if (
    extension.timeout != null &&
    (!Number.isFinite(extension.timeout) ||
      extension.timeout <= 0 ||
      extension.timeout > 3600)
  )
    throw invalid("Builtin MCP timeout must be between 0 and 3600 seconds");
  const directory = await canonicalDirectory(cwd, "Workspace cwd");
  const entry = builtins[extension.name];
  const command = await verifiedBinary(entry.artifact);
  return {
    serverName: extension.name,
    transport: "stdio",
    command,
    args: [...entry.args],
    cwd: directory,
    env: await toolEnvironment(dataDir, extension.name),
    toolCallTimeoutMs: (extension.timeout ?? 300) * 1000,
    failOnStartupError: true,
  };
}

// Testing uses the exact same command, profile and MCP configuration as sessions.
export const toTestExtension = builtinMcp;
