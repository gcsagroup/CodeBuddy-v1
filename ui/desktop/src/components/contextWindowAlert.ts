import { AlertType } from './alerts';

export function getContextAlertType(totalTokens: number, tokenLimit: number): AlertType {
  const percentage = tokenLimit > 0 ? (totalTokens / tokenLimit) * 100 : 0;

  if (percentage > 90) return AlertType.Error;
  if (percentage > 75) return AlertType.Warning;
  return AlertType.Info;
}

export function shouldShowContextAlert(
  totalTokens: number,
  tokenLimit: number,
  isTokenLimitLoaded: boolean
): boolean {
  return tokenLimit > 0 && (totalTokens > 0 || isTokenLimitLoaded);
}
