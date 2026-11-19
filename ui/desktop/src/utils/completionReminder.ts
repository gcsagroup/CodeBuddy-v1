import type { Rectangle } from 'electron';

export const completionIdleMs = 3000;

export function completionPopupBounds(area: Rectangle, measured: number): Rectangle {
  const width = Math.min(380, area.width);
  const height = Math.min(area.height, Math.max(96, Math.ceil(measured) || 160));
  return { width, height, x: Math.max(area.x, area.x + area.width - width - 14),
    y: Math.max(area.y, area.y + area.height - height - 14) };
}
