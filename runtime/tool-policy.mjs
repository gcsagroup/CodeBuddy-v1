import {
  resolveSessionExtensions,
  configuredExtension,
  extensionName,
} from "./session-extensions.mjs";
import { agentAllowsTool } from './agent-profiles.mjs';
import { GIT_TOOL_NAMES } from "./git-extension.mjs";
import { MCP_RESOURCE_TOOL_NAMES } from './mcp-settings.mjs';

export function publicToolName(name) {
  if (name.startsWith("mcp__")) return name.slice(5);
  if (name === "project_memory") return "projectmemory__project_memory";
  if (name === "codebuddy_task") return "codepro__codebuddy_task";
  if (GIT_TOOL_NAMES.includes(name)) return `git__${name}`;
  return `developer__${name}`;
}
export function harnessToolName(name) {
  for (const prefix of ["developer__", "codepro__", "projectmemory__", "git__"])
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  if (!name.startsWith("mcp__") && name.includes("__")) return `mcp__${name}`;
  return name;
}
export function hostToolExtensionName(name) {
  return name === 'project_memory' ? 'projectmemory' : GIT_TOOL_NAMES.includes(name) ? 'git' : 'developer';
}
export async function toolEnabled(session, settings, name, resolved) {
  if (!agentAllowsTool(session.agentProfile, name)) return false;
  if (name === 'workspace_memory') return session.globalConversation === true;
  if (name === "codebuddy_task") return session.type === "code_pro";
  const snapshot =
    resolved ?? (await resolveSessionExtensions(session, settings));
  snapshot.assertCurrent(session);
  const entries = snapshot.selected;
  // Discovery only exposes schemas already registered in this session. It serves
  // every extension; disabling developer must not strand Git or MCP tools.
  if (name === "search_mcp_tools")
    return entries.length > 0 || snapshot.mcpServers.length > 0;
  if (MCP_RESOURCE_TOOL_NAMES.includes(name))
    return (
      entries.some(
        (e) =>
          e.extension.type === "mcp" ||
          ["qwen_computer", "computercontroller", "autovisualiser", "commonqueries"].includes(
            extensionName(e.extension),
          ),
      ) || snapshot.mcpServers.length > 0
    );
  if (name.startsWith("mcp__")) {
    const extension = entries.find((e) =>
      name.startsWith(`mcp__${extensionName(e.extension)}__`),
    );
    if (extension)
      return (
        !extension.extension.available_tools?.length ||
        extension.extension.available_tools.some(
          (t) => name === `mcp__${extensionName(extension.extension)}__${t}`,
        )
      );
    return snapshot.mcpServers.some((server) =>
      name.startsWith(`mcp__${server.name}__`),
    );
  }
  const owner = hostToolExtensionName(name);
  const entry = entries.find(
    (e) => e.configKey === owner || extensionName(e.extension) === owner,
  );
  // Legacy pure-driver fixtures and older profiles have no configured registry.
  if (!entry)
    return (
      owner === "developer" &&
      !configuredExtension(snapshot.configured, "developer") &&
      session.extensions == null
    );
  return (
    !entry.extension.available_tools?.length ||
    entry.extension.available_tools.includes(name) ||
    entry.extension.available_tools.includes(publicToolName(name))
  );
}
