import { describe, expect, it } from 'vitest';
import { AlertType } from './alerts';
import { getContextAlertType, shouldShowContextAlert } from './contextWindowAlert';

describe('context window alerts', () => {
  it.each([
    [0, 128_000, AlertType.Info],
    [96_000, 128_000, AlertType.Info],
    [96_001, 128_000, AlertType.Warning],
    [115_200, 128_000, AlertType.Warning],
    [115_201, 128_000, AlertType.Error],
  ])('classifies %i of %i', (used, limit, expected) => {
    expect(getContextAlertType(used, limit)).toBe(expected);
  });

  it('shows a disabled compact control when a known limit has zero usage', () => {
    expect(shouldShowContextAlert(0, 128_000, true)).toBe(true);
    expect(shouldShowContextAlert(0, 128_000, false)).toBe(false);
    expect(shouldShowContextAlert(5000, 0, false)).toBe(false);
  });
});
