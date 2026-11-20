import type { IntlShape } from 'react-intl';
import type { ToolboxItem } from '../../types/toolbox';
import { localizeKnownBuiltInSkill, localizeSkillEntry } from '../skills/SkillsView';
import { getFriendlyTitle, getSubtitle } from '../settings/extensions/subcomponents/ExtensionList';
import { localizePlatformExtension } from '../settings/extensions/platformExtensionLocalization';
import { defineMessages } from '../../i18n';
import { selectNativeText } from '../../utils/nativeLocalization';

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
  if (item.repositoryMembers)
    return {
      ...item,
      name: selectNativeText(intl.locale, 'Code repositories', '代码仓库', '程式碼儲存庫'),
      description: selectNativeText(
        intl.locale,
        'Manage local changes, commits and branches. Connect GitHub for pull requests, issues and Actions.',
        '管理本地改动、提交和分支；连接 GitHub 后可处理 PR、Issue 和 Actions。',
        '管理本機變更、提交與分支；連線 GitHub 後可處理 PR、Issue 與 Actions。'
      ),
    };
  if (item.skillSource) {
    const builtIn =
      'type' in item.skillSource
        ? item.skillSource.type === 'builtinSkill'
        : item.skillSource.source.rootKind === 'builtin';
    const developmentSkills: Record<string, [string, string, string]> = {
      'web-acceptance': ['Web acceptance', '网页交付验收', '網頁交付驗收'],
      'code-navigation': ['Code definitions and references', '代码定义与引用', '程式碼定義與引用'],
      'versioned-docs': ['Version-matched documentation', '按版本查询文档', '按版本查詢文件'],
      'media-quality': ['Media quality inspection', '媒体与动画质检', '媒體與動畫品質檢查'],
    };
    const developmentDescriptions: Record<string, [string, string, string]> = {
      'web-acceptance': ['Check browser interactions, mobile layout and accessibility.', '检查网页交互、手机布局和无障碍问题。', '檢查網頁互動、手機版面和無障礙問題。'],
      'code-navigation': ['Find code definitions and references to assess change impact.', '查找代码定义与引用，分析改动影响范围。', '尋找程式碼定義與引用，分析變更影響範圍。'],
      'versioned-docs': ['Look up API documentation for the project dependency version.', '按项目依赖版本查询 API 文档与官方依据。', '依專案相依版本查詢 API 文件與官方依據。'],
      'media-quality': ['Inspect media dimensions, transparent bounds and animation timing.', '检查尺寸、透明轮廓、空白帧和动画时序。', '檢查尺寸、透明輪廓、空白影格和動畫時序。'],
    };
    if (builtIn && developmentSkills[item.skillSource.name]) {
      return { ...item, name: selectNativeText(intl.locale, ...developmentSkills[item.skillSource.name]),
        description: selectNativeText(intl.locale, ...developmentDescriptions[item.skillSource.name]) };
    }
    if (builtIn && item.skillSource.name === 'systematic-debugging') {
      return { ...item,
        name: selectNativeText(intl.locale, 'Systematic Debugging', '系统化排错', '系統化除錯'),
        description: selectNativeText(intl.locale, 'Reproduce a failure and trace its cause before fixing it.',
          '复现异常，追踪原因，再修复问题。', '重現異常，追蹤原因，再修正問題。'),
      };
    }
    if (builtIn && item.skillSource.name === 'verification-before-completion') {
      return { ...item,
        name: selectNativeText(intl.locale, 'Verification Before Completion', '完成前验证', '完成前驗證'),
        description: selectNativeText(intl.locale, 'Run checks and examine their results before reporting completion.',
          '交付前运行相关检查，核对结果后再报告完成。', '交付前執行相關檢查，核對結果後再回報完成。'),
      };
    }
    if (builtIn && item.skillSource.name === 'modern-web-guidance') {
      return {
        ...item,
        name: selectNativeText(intl.locale, 'Modern Web Guidance', '现代 Web 开发指南', '現代 Web 開發指南'),
        description: selectNativeText(intl.locale, 'Offline guides for building and reviewing web interfaces.',
          '开发或审查网页时，按需查阅表单、布局、交互、无障碍和性能指南。',
          '開發或審查網頁時，按需查閱表單、版面、互動、無障礙和效能指南。'),
      };
    }
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
