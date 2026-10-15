export function selectNativeText(
  locale: string,
  english: string,
  simplifiedChinese: string,
  traditionalChinese: string
): string {
  const normalized = locale.replace(/_/g, '-').toLowerCase();
  if (/^zh-(hant|tw|hk|mo)\b/.test(normalized)) {
    return traditionalChinese;
  }
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return simplifiedChinese;
  }
  return english;
}
