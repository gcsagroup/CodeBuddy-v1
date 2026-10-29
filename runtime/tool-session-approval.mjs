// Host factories opt in after defining their execution and scope. Tool names,
// schemas and remote annotations alone never manufacture a session grant.
import { isDeepStrictEqual } from 'node:util';

const registrations = new WeakMap();
const mcpRegistrations = new WeakMap();
const mcpScopes = new WeakSet();
export function registerToolSessionApproval(tool, { key, dependencies = [], accepts = () => true, business }) {
  const scope = Object.freeze({ key, dependencies: Object.freeze([...dependencies]), accepts,
    ...(business ? { business: Object.freeze({ ...business }) } : {}) });
  registrations.set(tool, { name: tool.name, execute: tool.execute, scope });
  return tool;
}
export function toolSessionApprovalScope(tool) {
  const entry = registrations.get(tool);
  return entry && tool.name === entry.name && tool.execute === entry.execute ? entry.scope : undefined;
}
export function sameToolSessionScope(a, b) {
  return Boolean(a && b && a.key === b.key && a.dependencies.length === b.dependencies.length &&
    a.dependencies.every((value, index) => value === b.dependencies[index]));
}

// Only the verified builtin factory calls this. Serializable MCP config and
// remote tool annotations cannot manufacture the registration.
export function registerMcpSessionApproval(config, { tools, business }) {
  const fields = ['serverName', 'transport', 'command', 'args', 'cwd', 'env'];
  const identity = value => Object.fromEntries(fields.map(key => [key,
    value[key] ?? (key === 'args' ? [] : key === 'env' ? {} : key === 'cwd' ? '' : undefined)]));
  const expected = structuredClone(identity(config));
  const members = Object.freeze([...tools]);
  const presentation = Object.freeze({ ...business, tools: members });
  const scope = Object.freeze({
    key: JSON.stringify([expected, members, presentation]),
    tools: members,
    business: presentation,
    accepts: value => isDeepStrictEqual(identity(value), expected),
  });
  mcpScopes.add(scope);
  mcpRegistrations.set(config, scope);
  return config;
}
export const mcpSessionApprovalScope = config => mcpRegistrations.get(config);
export const isMcpSessionApprovalScope = scope => mcpScopes.has(scope);
