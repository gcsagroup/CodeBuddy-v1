import type { IntlShape } from 'react-intl';
import type { ToolboxItem } from '../../types/toolbox';
import { localizeKnownBuiltInSkill, localizeSkillEntry } from '../skills/SkillsView';
import { getFriendlyTitle, getSubtitle } from '../settings/extensions/subcomponents/ExtensionList';
import { localizePlatformExtension } from '../settings/extensions/platformExtensionLocalization';

export function localizeToolboxItem(item: ToolboxItem, intl: IntlShape): ToolboxItem {
  if (item.skillSource) {
    if ('type' in item.skillSource) {
      return { ...item, ...localizeSkillEntry(item.skillSource, intl) };
    }
    const locale = intl.locale;
    const language = locale.split('-')[0];
    const locales = item.skillSource.displayMetadata?.locales ?? {};
    const localized = locales[locale] ?? locales[language];
    if (localized) return { ...item, ...localized };
    return item.skillSource.source.rootKind === 'builtin'
      ? { ...item, ...localizeKnownBuiltInSkill(item.skillSource, intl) }
      : item;
  }
  const extension = item.extensionSource;
  if (!extension) return item;
  const platform = localizePlatformExtension(extension, intl);
  if (platform) return { ...item, ...platform };
  if (extension.type === 'builtin') {
    return {
      ...item,
      name: getFriendlyTitle(extension, intl),
      description: getSubtitle(extension, intl).description ?? '',
    };
  }
  return item;
}
