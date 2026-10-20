import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { invalid } from "./providers.mjs";
import { mcpToolCallTimeoutMs } from './mcp-settings.mjs';
import { builtinArtifacts, verifiedBinary } from './builtin-artifacts.mjs';

const builtins = {
  commonqueries: {
    artifact: 'tools',
    args: ["mcp", "commonqueries"],
    displayName: "时间与天气",
    description: "读取主机时间、解析城市并按设置查询天气。",
    tools: ["time_now", "location_resolve", "weather_get"],
  },
  qwen_computer: {
    artifact: 'computer',
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
    artifact: 'tools',
    args: ["mcp", "computercontroller"],
    displayName: "PDF 与网页文件",
    description: "提取 PDF、保存网页文件并管理工具缓存。Word、Excel 和 PowerPoint 使用 Office 技能。",
    tools: ["cache", "pdf_tool", "web_scrape"],
  },
  autovisualiser: {
    artifact: 'tools',
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


async function verifiedEntry(entry, platform = process.platform, arch = process.arch) {
  try {
    const artifacts = await builtinArtifacts(platform, arch);
    // Go dispatches to this fixed sibling helper. Validate both parts before
    // catalog availability or startup, not merely the MCP front-end executable.
    if (entry.artifact === 'computer' && platform === 'darwin') await verifiedBinary(artifacts.helper);
    return await verifiedBinary(artifacts[entry.artifact]);
  } catch (error) { throw invalid(error.message); }
}

/** Availability is artifact validation, not a live MCP tools/list result. */
export async function listAvailableBuiltins({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return Promise.all(
    Object.entries(builtins).map(async ([name, entry]) => {
      let reason;
      try {
        await verifiedEntry(entry, platform, arch);
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

/** Only tool-only stdio MCP entrypoints are shipped; no legacy Agent executable. */
export async function builtinMcp(extension, { cwd, dataDir } = {}) {
  if (!isBuiltinMcp(extension)) return undefined;
  const toolCallTimeoutMs = mcpToolCallTimeoutMs(extension);
  const directory = await canonicalDirectory(cwd, "Workspace cwd");
  const entry = builtins[extension.name];
  let command;
  try { command = await verifiedEntry(entry); }
  catch (error) { throw invalid(error.message); }
  return {
    serverName: extension.name,
    transport: "stdio",
    command,
    args: [...entry.args],
    cwd: directory,
    env: await toolEnvironment(dataDir, extension.name),
    toolCallTimeoutMs,
    failOnStartupError: true,
  };
}

// Testing uses the exact same command, profile and MCP configuration as sessions.
export const toTestExtension = builtinMcp;
