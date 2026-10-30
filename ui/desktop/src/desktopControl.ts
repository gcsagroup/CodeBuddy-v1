export interface DesktopControlState {
  sessionId: string;
  token: string;
  active: boolean;
}

export function parseDesktopControl(sessionId: string, value: unknown): DesktopControlState | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (
    data.event !== 'desktop_control' ||
    typeof data.token !== 'string' ||
    !data.token ||
    data.token.length > 256 ||
    typeof data.active !== 'boolean'
  )
    return null;
  return { sessionId, token: data.token, active: data.active };
}
