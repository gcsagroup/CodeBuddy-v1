import type { SourceEntry, SourceType } from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import { projectPathIdentity } from '../utils/projectSessions';

const SKILL_SOURCE_TYPES: SourceType[] = ['skill', 'builtinSkill'];
const inFlightSkillSourceLoads = new Map<string, Promise<SourceEntry[]>>();

export interface CodeProProjectBinding {
  projectId: string;
  source: SourceEntry;
  created: boolean;
}

interface CodeProProjectInput {
  workingDir: string;
  normalizedIdentity: string;
  displayName: string;
  suggestedProjectId: string;
}

function projectMatchesWorkspace(source: SourceEntry, input: CodeProProjectInput): boolean {
  const properties = source.properties ?? {};
  if (
    typeof properties.codeproWorkspaceIdentity === 'string' &&
    properties.codeproWorkspaceIdentity === input.normalizedIdentity
  ) {
    return true;
  }

  return (
    Array.isArray(properties.workingDirs) &&
    properties.workingDirs.some(
      (workingDir) =>
        typeof workingDir === 'string' &&
        projectPathIdentity(workingDir) === input.normalizedIdentity
    )
  );
}

function binding(source: SourceEntry, created: boolean): CodeProProjectBinding {
  return { projectId: source.name, source, created };
}

export async function findOrCreateCodeProProject(
  input: CodeProProjectInput
): Promise<CodeProProjectBinding> {
  const client = await getAcpClient();
  const listProjects = async () =>
    (await client.goose.sourcesList_unstable({ type: 'project' })).sources;

  const existing = (await listProjects()).find((source) => projectMatchesWorkspace(source, input));
  if (existing) return binding(existing, false);

  try {
    const response = await client.goose.sourcesCreate_unstable({
      type: 'project',
      name: input.suggestedProjectId,
      description: `CodePro workspace at ${input.workingDir}`,
      content: '',
      target: { scope: 'global' },
      properties: {
        title: input.displayName,
        workingDirs: [input.workingDir],
        codeproWorkspaceIdentity: input.normalizedIdentity,
      },
    });
    return binding(response.source, true);
  } catch (error) {
    const concurrent = (await listProjects()).find((source) =>
      projectMatchesWorkspace(source, input)
    );
    if (concurrent) return binding(concurrent, false);
    throw error;
  }
}

export async function listSkillSources(projectDir: string): Promise<SourceEntry[]> {
  const inFlightLoad = inFlightSkillSourceLoads.get(projectDir);
  if (inFlightLoad) {
    return inFlightLoad;
  }

  const load = loadSkillSources(projectDir);
  inFlightSkillSourceLoads.set(projectDir, load);

  try {
    return await load;
  } finally {
    if (inFlightSkillSourceLoads.get(projectDir) === load) {
      inFlightSkillSourceLoads.delete(projectDir);
    }
  }
}

async function loadSkillSources(projectDir: string): Promise<SourceEntry[]> {
  const client = await getAcpClient();
  const responses = await Promise.all(
    SKILL_SOURCE_TYPES.map((type) =>
      client.goose.sourcesList_unstable({
        type,
        projectDir,
      })
    )
  );

  return responses
    .flatMap((response) => response.sources)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.path.localeCompare(b.path)
    );
}
