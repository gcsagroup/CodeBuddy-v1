// Backport Pi #11891 through the existing pinned loader. Counting and streaming
// share buildParams; never change just the HTTP payload after request fitting.
const replace = (source, previous, replacement) => {
  if (source.split(previous).length !== 2)
    throw new Error('Review the pinned Pi empty-tools compatibility contract.');
  return source.replace(previous, replacement);
};

export function patchChatTools(source) {
  source = replace(source, 'else if (hasToolHistory(context.messages)) {',
    'else if (compat.requiresToolsWithToolHistory && hasToolHistory(context.messages)) {');
  return replace(source, 'supportsStore: model.compat.supportsStore ?? detected.supportsStore,',
    'requiresToolsWithToolHistory: model.compat.requiresToolsWithToolHistory ?? false,\n        supportsStore: model.compat.supportsStore ?? detected.supportsStore,');
}

export const piCompatSchemaPatch = {
  name: '@earendil-works/pi-ai/providers/compat-schema',
  hash: '424a688c89282b3f27d6648d0b7c55ccd13c896950496caded1ae42a26b65c9c',
  transform: source => replace(source, 'export const OpenAICompletionsCompatSchema = Type.Object({',
    'export const OpenAICompletionsCompatSchema = Type.Object({\n    requiresToolsWithToolHistory: Type.Optional(Type.Boolean()),'),
};
