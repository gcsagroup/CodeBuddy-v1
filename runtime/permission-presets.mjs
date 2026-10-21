// Transport vocabulary only. DSH owns the effective session permission state.
export const permissionPresets = ['read-only', 'workspace-write', 'danger-full-access'];

export function initialPermissionPreset(session, preferences = {}) {
  const requested = session.initialPermissionPreset ?? session.mode ?? preferences.gooseMode;
  // Legacy approval modes are not sandbox presets. Do not translate an old grant
  // into broader native file access; users can select a native preset explicitly.
  return permissionPresets.includes(requested) ? requested : requested == null ? 'workspace-write' : 'read-only';
}
