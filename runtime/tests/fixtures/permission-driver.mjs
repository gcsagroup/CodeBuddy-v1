// ACP-only fixtures stand in for the native service. Execution/security tests
// use the real alpha2 Host instead of this protocol stub.
export function permissionDriver() {
  const sessions = new Map();
  return async (id, { initialPreset = 'workspace-write', preset } = {}) => {
    if (!sessions.has(id)) sessions.set(id, initialPreset);
    if (preset !== undefined) sessions.set(id, preset);
    return { preset: sessions.get(id) };
  };
}
