// Host factories opt in after defining their execution and scope. Tool names,
// schemas and remote annotations alone never manufacture a session grant.
const registrations = new WeakMap();
export function registerToolSessionApproval(tool, { key, dependencies = [], accepts = () => true }) {
  const scope = Object.freeze({ key, dependencies: Object.freeze([...dependencies]), accepts });
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
