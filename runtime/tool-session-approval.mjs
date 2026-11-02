// Host factories opt in after defining their execution and scope. Tool names,
// schemas and remote annotations alone never manufacture a session grant.
import { isDeepStrictEqual } from 'node:util';

const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// Display data comes only from a registered host factory. It is part of the
// scope identity: changing the declared range requires a new explicit choice.
function businessPresentation(business, tools = business?.tools) {
  if (!business) return undefined;
  const value = structuredClone(business);
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new TypeError('Business approval tools must be an array');
    value.tools = [...tools];
  }
  if (value.version === 2) {
    if (!text(value.id, 128) || !text(value.name, 160) || !text(value.description, 4096))
      throw new TypeError('Business approval requires an id, name and description');
    if (value.details !== undefined && (!Array.isArray(value.details) || value.details.length > 16 ||
      value.details.some(item => !item || !text(item.label, 160) || !text(item.value, 4096))))
      throw new TypeError('Invalid business approval details');
    if (value.details) value.details = Object.freeze(value.details.map(item => Object.freeze({ label: item.label, value: item.value })));
  } else if (value.version !== undefined || !['computer-use', 'image-generation', 'video-generation'].includes(value.id)) {
    throw new TypeError('New business approvals require the extensible version 2 descriptor');
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || !value.tools.length || value.tools.length > 256 ||
      value.tools.some(tool => !text(tool, 256)) || new Set(value.tools).size !== value.tools.length)
      throw new TypeError('Invalid business approval tool range');
    value.tools = Object.freeze(value.tools);
  }
  return Object.freeze(value);
}

export function businessPresentationForClient(business, version) {
  if (!business || ![1, 2].includes(version)) return undefined;
  // Old clients retain per-tool approval when the factory adopts a new contract.
  // Never strip a new range description to squeeze it into an older category.
  return version === 2 || business.version === undefined ? business : undefined;
}

const registrations = new WeakMap();
const mcpRegistrations = new WeakMap();
const mcpScopes = new WeakSet();
export function registerToolSessionApproval(tool, { key, dependencies = [], accepts = () => true, business }) {
  const scope = Object.freeze({ key, dependencies: Object.freeze([...dependencies]), accepts,
    ...(business ? { business: businessPresentation(business) } : {}) });
  registrations.set(tool, { name: tool.name, execute: tool.execute, scope });
  return tool;
}
export function toolSessionApprovalScope(tool) {
  const entry = registrations.get(tool);
  return entry && tool.name === entry.name && tool.execute === entry.execute ? entry.scope : undefined;
}
export function sameToolSessionScope(a, b) {
  return Boolean(a && b && a.key === b.key && a.dependencies.length === b.dependencies.length &&
    a.dependencies.every((value, index) => value === b.dependencies[index]) && isDeepStrictEqual(a.business, b.business));
}

// Only the verified builtin factory calls this. Serializable MCP config and
// remote tool annotations cannot manufacture the registration.
export function registerMcpSessionApproval(config, { tools, business }) {
  const fields = ['serverName', 'transport', 'command', 'args', 'cwd', 'env'];
  const identity = value => Object.fromEntries(fields.map(key => [key,
    value[key] ?? (key === 'args' ? [] : key === 'env' ? {} : key === 'cwd' ? '' : undefined)]));
  const expected = structuredClone(identity(config));
  const members = Object.freeze([...tools]);
  const presentation = businessPresentation(business, members);
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
