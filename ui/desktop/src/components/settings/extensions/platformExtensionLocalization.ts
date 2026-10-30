import type { IntlShape, MessageDescriptor } from 'react-intl';
import { defineMessages } from '../../../i18n';
import type { ExtensionConfig } from '../../../types/extensions';

const messages = defineMessages({
  playwrightName: {
    id: 'platformExtension.playwright.name',
    defaultMessage: 'Browser control · Separate window',
  },
  playwrightDescription: {
    id: 'platformExtension.playwright.description',
    defaultMessage:
      'Observe and test websites in a separate Edge (Windows) or Chrome (Mac) window with Playwright MCP.',
  },
  playwrightUserName: {
    id: 'platformExtension.playwrightUser.name',
    defaultMessage: 'Browser control · Your browser',
  },
  playwrightUserDescription: {
    id: 'platformExtension.playwrightUser.description',
    defaultMessage:
      'Connect to a Chrome or Edge tab you select. Install the official Playwright extension and confirm the connection in your browser.',
  },
  commonqueriesName: {
    id: 'platformExtension.commonqueries.name',
    defaultMessage: 'Common queries',
  },
  commonqueriesDescription: {
    id: 'platformExtension.commonqueries.description',
    defaultMessage: 'Read time, resolve cities, and query weather with sources.',
  },
  analyzeName: { id: 'platformExtension.analyze.name', defaultMessage: 'Code analysis' },
  analyzeDescription: {
    id: 'platformExtension.analyze.description',
    defaultMessage: 'Inspect code structure, files, and symbol relationships.',
  },
  appsName: { id: 'platformExtension.apps.name', defaultMessage: 'Mini tools' },
  appsDescription: {
    id: 'platformExtension.apps.description',
    defaultMessage: 'Create and manage small apps that run in isolated windows.',
  },
  computerName: { id: 'platformExtension.computer.name', defaultMessage: 'Computer Use' },
  computerDescription: {
    id: 'platformExtension.computer.description',
    defaultMessage: 'Observe and control desktop applications.',
  },
  developerName: { id: 'platformExtension.developer.name', defaultMessage: 'Development tools' },
  developerDescription: {
    id: 'platformExtension.developer.description',
    defaultMessage: 'Read, write, and edit files, and run shell commands.',
  },
  skillsName: { id: 'platformExtension.skills.name', defaultMessage: 'Skills' },
  skillsDescription: {
    id: 'platformExtension.skills.description',
    defaultMessage: 'Discover and load installed and built-in skill instructions.',
  },
  chatrecallName: {
    id: 'platformExtension.chatrecall.name',
    defaultMessage: 'Conversation recall',
  },
  chatrecallDescription: {
    id: 'platformExtension.chatrecall.description',
    defaultMessage: 'Search previous conversations and read their summaries.',
  },
  extensionmanagerName: {
    id: 'platformExtension.extensionmanager.name',
    defaultMessage: 'Extension manager',
  },
  extensionmanagerDescription: {
    id: 'platformExtension.extensionmanager.description',
    defaultMessage: 'Discover, enable, and disable extensions.',
  },
  gitName: { id: 'platformExtension.git.name', defaultMessage: 'Git' },
  gitDescription: {
    id: 'platformExtension.git.description',
    defaultMessage: 'Run bounded, structured Git operations.',
  },
  summonName: { id: 'platformExtension.summon.name', defaultMessage: 'Delegation' },
  summonDescription: {
    id: 'platformExtension.summon.description',
    defaultMessage: 'Load knowledge and delegate tasks to agents.',
  },
  summarizeName: { id: 'platformExtension.summarize.name', defaultMessage: 'Summarization' },
  summarizeDescription: {
    id: 'platformExtension.summarize.description',
    defaultMessage: 'Read files or directories and generate a summary.',
  },
  todoName: { id: 'platformExtension.todo.name', defaultMessage: 'Task checklist' },
  todoDescription: {
    id: 'platformExtension.todo.description',
    defaultMessage: 'Track the steps and progress of the current task.',
  },
  tomName: { id: 'platformExtension.tom.name', defaultMessage: 'Persistent context' },
  tomDescription: {
    id: 'platformExtension.tom.description',
    defaultMessage: 'Add configured context to each conversation turn.',
  },
  codeexecutionName: { id: 'platformExtension.codeexecution.name', defaultMessage: 'Code mode' },
  codeexecutionDescription: {
    id: 'platformExtension.codeexecution.description',
    defaultMessage: 'Call extensions through code execution to reduce token use.',
  },
  codepromemoryName: {
    id: 'platformExtension.codepromemory.name',
    defaultMessage: 'Activity memory',
  },
  codepromemoryDescription: {
    id: 'platformExtension.codepromemory.description',
    defaultMessage: 'Read bounded activity history for the current task.',
  },
  projectmemoryName: {
    id: 'platformExtension.projectmemory.name',
    defaultMessage: 'Project memory',
  },
  projectmemoryDescription: {
    id: 'platformExtension.projectmemory.description',
    defaultMessage: 'Store user-authorized project rules, preferences, and verified facts.',
  },
  orchestratorName: {
    id: 'platformExtension.orchestrator.name',
    defaultMessage: 'Agent coordination',
  },
  orchestratorDescription: {
    id: 'platformExtension.orchestrator.description',
    defaultMessage: 'Manage agent sessions and their work.',
  },
});

const metadata: Record<string, { name: MessageDescriptor; description: MessageDescriptor }> = {
  commonqueries: {
    name: messages.commonqueriesName,
    description: messages.commonqueriesDescription,
  },
  analyze: { name: messages.analyzeName, description: messages.analyzeDescription },
  apps: { name: messages.appsName, description: messages.appsDescription },
  qwencomputer: { name: messages.computerName, description: messages.computerDescription },
  developer: { name: messages.developerName, description: messages.developerDescription },
  skills: { name: messages.skillsName, description: messages.skillsDescription },
  chatrecall: { name: messages.chatrecallName, description: messages.chatrecallDescription },
  extensionmanager: {
    name: messages.extensionmanagerName,
    description: messages.extensionmanagerDescription,
  },
  playwright: { name: messages.playwrightName, description: messages.playwrightDescription },
  playwrightuser: {
    name: messages.playwrightUserName,
    description: messages.playwrightUserDescription,
  },
  git: { name: messages.gitName, description: messages.gitDescription },
  summon: { name: messages.summonName, description: messages.summonDescription },
  summarize: { name: messages.summarizeName, description: messages.summarizeDescription },
  todo: { name: messages.todoName, description: messages.todoDescription },
  tom: { name: messages.tomName, description: messages.tomDescription },
  codeexecution: {
    name: messages.codeexecutionName,
    description: messages.codeexecutionDescription,
  },
  codepromemory: {
    name: messages.codepromemoryName,
    description: messages.codepromemoryDescription,
  },
  projectmemory: {
    name: messages.projectmemoryName,
    description: messages.projectmemoryDescription,
  },
  orchestrator: { name: messages.orchestratorName, description: messages.orchestratorDescription },
};

export function localizePlatformExtension(
  extension: ExtensionConfig,
  intl: IntlShape
): { name: string; description: string } | undefined {
  if (
    extension.type !== 'platform' &&
    !(
      extension.type === 'builtin' &&
      ['qwen_computer', 'playwright', 'playwright_user'].includes(extension.name)
    )
  )
    return undefined;
  const entry = metadata[extension.name.toLowerCase().replace(/[\s_-]/g, '')];
  return entry
    ? { name: intl.formatMessage(entry.name), description: intl.formatMessage(entry.description) }
    : undefined;
}
