import { errorMessage } from '../utils/conversionUtils';
import type { ToolboxModel } from '../types/toolbox';
import { buildToolboxModel } from '../components/toolbox/toolboxModel';
import { getConfiguredExtensions } from './extensions';
import { listCapabilityUsage } from './capabilityUsage';
import { listManagedSkills } from './skillManagement';

export type ToolboxLoadErrors = Partial<
  Record<'capabilities' | 'methods' | 'apps' | 'external', string>
>;

export interface ToolboxLoadResult {
  model: ToolboxModel;
  errors: ToolboxLoadErrors;
  warnings: string[];
}

export async function loadToolbox(
  projectDir: string,
  _sessionId?: string,
  options: { includeUsage?: boolean; onPartial?: (result: ToolboxLoadResult) => void } = {}
): Promise<ToolboxLoadResult> {
  let skills: Awaited<ReturnType<typeof listManagedSkills>>['skills'] = [];
  let extensions: Awaited<ReturnType<typeof getConfiguredExtensions>>['extensions'] = [];
  const publish = () => options.onPartial?.({
    model: buildToolboxModel({ skills, extensions, apps: [], usage: [] }), errors: {}, warnings: [],
  });
  const [skillsResult, extensionsResult, usageResult] = await Promise.allSettled([
    listManagedSkills(projectDir).then(result => { skills = result.skills; publish(); return result; }),
    getConfiguredExtensions().then(result => { extensions = result.extensions; publish(); return result; }),
    options.includeUsage === false ? Promise.resolve({ records: [], warning: undefined }) : listCapabilityUsage(),
  ]);
  const errors: ToolboxLoadErrors = {};

  if (skillsResult.status === 'rejected') errors.methods = errorMessage(skillsResult.reason);
  if (extensionsResult.status === 'rejected') {
    const message = errorMessage(extensionsResult.reason);
    errors.external = message;
  }

  const configuredExtensions =
    extensionsResult.status === 'fulfilled'
      ? extensionsResult.value
      : { extensions: [], warnings: [] };

  return {
    model: buildToolboxModel({
      skills: skillsResult.status === 'fulfilled' ? skillsResult.value.skills : [],
      apps: [],
      extensions: configuredExtensions.extensions,
      usage: usageResult.status === 'fulfilled' ? usageResult.value.records : [],
    }),
    errors,
    warnings: [
      ...(skillsResult.status === 'fulfilled' ? skillsResult.value.diagnostics ?? [] : []),
      ...configuredExtensions.warnings,
      ...(usageResult.status === 'fulfilled' && usageResult.value.warning
        ? [usageResult.value.warning]
        : usageResult.status === 'rejected'
          ? [errorMessage(usageResult.reason)]
          : []),
    ],
  };
}
