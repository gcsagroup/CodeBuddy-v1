export interface Typography {
  windowZoom: number;
  textSize: number;
  codeFontSize: number;
  uiFont: 'default' | 'system' | 'serif';
}

export const defaultTypography: Typography = {
  windowZoom: 100,
  textSize: 14,
  codeFontSize: 12,
  uiFont: 'default',
};
export const zoomRange = { min: 80, max: 300, step: 10 };
export const textSizeRange = { min: 12, max: 24, step: 1 };
export const codeSizeRange = { min: 10, max: 48, step: 1 };

function inRange(value: unknown, range: typeof zoomRange): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max &&
    (value - range.min) % range.step === 0
  );
}

export function readTypography(value: Partial<Record<keyof Typography, unknown>>): Typography {
  return {
    windowZoom: inRange(value.windowZoom, zoomRange)
      ? value.windowZoom
      : defaultTypography.windowZoom,
    textSize: inRange(value.textSize, textSizeRange) ? value.textSize : defaultTypography.textSize,
    codeFontSize: inRange(value.codeFontSize, codeSizeRange)
      ? value.codeFontSize
      : defaultTypography.codeFontSize,
    uiFont: value.uiFont === 'system' || value.uiFont === 'serif' ? value.uiFont : 'default',
  };
}
