import { isManagedCapability } from '../settings/extensions/managed-capabilities';
import type { ManagedSkill, SourceEntry } from '@aaif/goose-sdk';
import type { GooseApp } from '../../types/apps';
import type { ConfiguredExtensionEntry } from '../../acp/extensions';
import type { ToolboxItem, ToolboxModel } from '../../types/toolbox';
import type { CapabilityUsageRecord } from '../../acp/capabilityUsage';

export interface ToolboxSources {
  skills: Array<SourceEntry | ManagedSkill>;
  apps: GooseApp[];
  extensions: ConfiguredExtensionEntry[];
  usage?: CapabilityUsageRecord[];
}

function sortItems(items: ToolboxItem[]): ToolboxItem[] {
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

const REQUIRED_PLATFORM_EXTENSION_KEYS = new Set(['developer', 'extensionmanager']);
const RETIRED_SKILL_NAMES = new Set(['goose-doc-guide']);

export function groupRepositoryTools(model: ToolboxModel): ToolboxModel {
  const members = [...model.capabilities, ...model.external].filter((item) => {
    const extension = item.extensionSource;
    if (!extension) return false;
    return (
      ((extension.type === 'builtin' || extension.type === 'platform') &&
        extension.name === 'git') ||
      (extension.type === 'stdio' && extension.name === 'local_git') ||
      (extension.type === 'streamable_http' &&
        extension.name === 'github_official' &&
        extension.uri === 'https://api.githubcopilot.com/mcp/')
    );
  });
  if (!members.length) return model;
  return {
    ...model,
    capabilities: model.capabilities.filter((item) => !members.includes(item)),
    methods: [
      ...model.methods,
      {
        id: 'builtin:repository',
        kind: 'builtin',
        source: 'extension',
        name: 'Code repositories',
        description: 'Local Git, GitHub repositories, pull requests, issues and Actions.',
        status: 'configured',
        actions: ['inspect'],
        repositoryMembers: members,
      },
    ],
    external: model.external.filter((item) => !members.includes(item)),
  };
}

export function buildToolboxModel(sources: ToolboxSources): ToolboxModel {
  const usageById = new Map(
    (sources.usage ?? []).map((usage) => [`${usage.kind}:${usage.capabilityId}`, usage])
  );
  const usageFor = (id: string) => {
    const usage = usageById.get(id);
    return usage
      ? {
          lastUsedAt: usage.lastSuccessAt,
          successCount: usage.successCount,
          recentResult: usage.recentResult,
        }
      : { successCount: 0 };
  };
  const methods = sources.skills
    .filter(
      (skill) =>
        !RETIRED_SKILL_NAMES.has(skill.name) &&
        (!('type' in skill) || skill.type === 'skill' || skill.type === 'builtinSkill')
    )
    .map<ToolboxItem>((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill',
      source: 'source',
      name: skill.name,
      description: skill.description,
      skillSource: skill,
      status: 'enabled' in skill && !skill.enabled ? 'disabled' : 'ready',
      actions:
        'readOnly' in skill && !skill.readOnly
          ? ['inspect', skill.enabled ? 'disable' : 'enable']
          : ['inspect'],
      reference: {
        key: 'path',
        value: 'displayPath' in skill ? skill.displayPath : skill.path,
      },
      usage: usageFor(`skill:${skill.name}`),
    }));

  const hasExternalGit = sources.extensions.some(
    (e) => e.type === 'stdio' && e.name === 'local_git'
  );
  const capabilities = sources.extensions
    .filter(
      (extension) =>
        (extension.type === 'builtin' || extension.type === 'platform') &&
        !isManagedCapability(extension) &&
        !['tutorial', 'computer'].includes(extension.name.toLowerCase()) &&
        !(hasExternalGit && extension.type === 'platform' && extension.name === 'git')
    )
    .map<ToolboxItem>((extension) => {
      const capabilityId = extension.configKey ?? extension.name;
      const locked =
        extension.type === 'platform' &&
        extension.enabled &&
        REQUIRED_PLATFORM_EXTENSION_KEYS.has(capabilityId.toLocaleLowerCase());
      return {
        id: `builtin:${capabilityId}`,
        kind: 'builtin',
        source: 'extension',
        name: extension.name,
        description: extension.description ?? '',
        status: extension.enabled ? 'configured' : 'disabled',
        actions: locked ? ['inspect'] : ['inspect', extension.enabled ? 'disable' : 'enable'],
        locked,
        tools: 'available_tools' in extension ? (extension.available_tools ?? []) : [],
        reference: { key: 'configKey', value: capabilityId },
        extensionSource: extension,
      };
    });

  const external = sources.extensions
    .filter((extension) => extension.type === 'stdio' || extension.type === 'streamable_http')
    .map<ToolboxItem>((extension) => {
      const capabilityId = extension.configKey ?? extension.name;
      const usage = usageFor(`external:${capabilityId}`);
      return {
        id: `external:${capabilityId}`,
        kind: 'external',
        source: 'extension',
        name: extension.name,
        description: extension.description ?? '',
        status: !extension.enabled ? 'disabled' : usage.successCount > 0 ? 'ready' : 'configured',
        actions: [extension.enabled ? 'disable' : 'enable', 'configure'],
        reference: { key: 'configKey', value: capabilityId },
        usage,
        extensionSource: extension,
      };
    });

  return {
    capabilities: sortItems(capabilities),
    methods: sortItems(methods),
    apps: [],
    external: sortItems(external),
  };
}
