import type { RecipeManifest } from '../../recipe';
import type { CapabilityUsageRecord } from '../../acp/capabilityUsage';

export interface CommonTaskModel {
  id: string;
  title: string;
  purpose: string;
  model: string;
  extensions: string[];
  knownFiles: string[];
  riskSummary: string[];
  lastRunAt?: string;
  recentResult?: string;
}

export function buildCommonTaskCreationPrompt(description: string): string | null {
  const trimmedDescription = description.trim();
  if (!trimmedDescription) return null;

  return [
    'Help me turn the following description into a reusable Common Task.',
    'Before saving it, confirm the purpose, model, tools, files, permissions, and run instructions with me.',
    '',
    trimmedDescription,
  ].join('\n');
}

export function buildCommonTaskModel(
  manifest: RecipeManifest,
  usage?: CapabilityUsageRecord
): CommonTaskModel {
  const { recipe } = manifest;
  const provider = recipe.settings?.goose_provider?.trim();
  const model = recipe.settings?.goose_model?.trim();
  const extensions = (recipe.extensions ?? []).map((extension) => extension.name);
  const fileParameters = (recipe.parameters ?? [])
    .filter((parameter) => parameter.input_type === 'file')
    .map((parameter) => parameter.key);
  const subRecipes = (recipe.sub_recipes ?? []).map((subRecipe) => subRecipe.path);
  const hasExternalTools = (recipe.extensions ?? []).some(
    (extension) => extension.type === 'stdio' || extension.type === 'streamable_http'
  );

  return {
    id: manifest.id,
    title: recipe.title,
    purpose: recipe.description,
    model: provider && model ? `${provider} / ${model}` : model || provider || 'Default model',
    extensions,
    knownFiles: [...fileParameters, ...subRecipes],
    riskSummary: hasExternalTools ? ['External tool access may require confirmation'] : [],
    lastRunAt: usage?.lastSuccessAt,
    recentResult: usage?.recentResult,
  };
}
