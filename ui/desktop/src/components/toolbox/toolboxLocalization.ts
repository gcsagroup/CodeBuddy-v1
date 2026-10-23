import type { IntlShape } from 'react-intl';
import type { ToolboxItem } from '../../types/toolbox';
import { localizeKnownBuiltInSkill, localizeSkillEntry } from '../skills/SkillsView';
import { getFriendlyTitle, getSubtitle } from '../settings/extensions/subcomponents/ExtensionList';
import { localizePlatformExtension } from '../settings/extensions/platformExtensionLocalization';
import { defineMessages } from '../../i18n';

const messages = defineMessages({
  computerGuide: { id: 'toolbox.computerGuide', defaultMessage: 'Desktop operation guide' },
  computerGuideDescription: {
    id: 'toolbox.computerGuideDescription',
    defaultMessage:
      'Guides the model through observation, input and result verification. Uses the Computer control tools.',
  },
  localGit: { id: 'toolbox.localGit', defaultMessage: 'Local Git' },
  localGitDescription: {
    id: 'toolbox.localGitDescription',
    defaultMessage: 'Inspect local changes and manage staging, commits and branches.',
  },
  githubDescription: {
    id: 'toolbox.githubDescription',
    defaultMessage:
      'Connect to GitHub to manage remote repositories, issues, pull requests and CI.',
  },
});

export function localizeToolboxItem(item: ToolboxItem, intl: IntlShape): ToolboxItem {
  if (item.skillSource) {
    const builtIn =
      'type' in item.skillSource
        ? item.skillSource.type === 'builtinSkill'
        : item.skillSource.source.rootKind === 'builtin';
    if (builtIn && item.skillSource.name === 'computer-use') {
      return {
        ...item,
        name: intl.formatMessage(messages.computerGuide),
        description: intl.formatMessage(messages.computerGuideDescription),
      };
    }
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
  if ((extension.type === 'builtin' || extension.type === 'platform') && extension.name === 'git') {
    return {
      ...item,
      name: intl.formatMessage(messages.localGit),
      description: intl.formatMessage(messages.localGitDescription),
    };
  }
  if (
    extension.type === 'streamable_http' &&
    extension.name === 'github_official' &&
    extension.uri === 'https://api.githubcopilot.com/mcp/'
  ) {
    return { ...item, name: 'GitHub', description: intl.formatMessage(messages.githubDescription) };
  }
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
