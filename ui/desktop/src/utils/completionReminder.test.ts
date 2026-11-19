import { expect, it } from 'vitest';
import { completionPopupBounds } from './completionReminder';

it('anchors the complete card above the taskbar on the active display', () => {
  expect(completionPopupBounds({ x: -1440, y: 20, width: 1440, height: 860 }, 156.2))
    .toEqual({ x: -394, y: 709, width: 380, height: 157 });
  expect(completionPopupBounds({ x: 0, y: 0, width: 340, height: 120 }, 180))
    .toEqual({ x: 0, y: 0, width: 340, height: 120 });
});
