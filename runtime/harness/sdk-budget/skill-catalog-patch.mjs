const replace = (source, before, after) => {
  if (source.split(before).length !== 2)
    throw new Error('Review the pinned native skill-catalog presentation contract.');
  return source.replace(before, after);
};

export const skillCatalogPatch = {
  name: '@deepseek-ai/dsh-tool-skill',
  hash: 'a77aaf64ae67383da4a7d47422e1d5e86ac3ab27e604967b00c2c57b00f68180',
  transform(source) {
    source = `import { renderSkillIndex } from ${JSON.stringify(new URL('../skill-catalog-presentation.mjs', import.meta.url).href)};\n` + source;
    // Registry precedence has already resolved winners. Presentation gives
    // explicitly installed/workspace skills space before bundled defaults.
    source = replace(source, '\t\tconst entries = catalogSourceEntries(skills, catalogDescriptionMaxLength);',
      '\t\tconst entries = catalogSourceEntries([...skills].sort((a, b) => Number(a.source === "bundled") - Number(b.source === "bundled")), catalogDescriptionMaxLength);');
    source = replace(source, 'description: catalogDescription(skill.description, descriptionMaxLength)',
      'description: catalogDescription(skill.description, descriptionMaxLength),\n\t\t...(typeof skill.revision === "string" ? { revision: skill.revision } : {})');
    source = replace(source, 'JSON.stringify([entry.name, entry.description])',
      'JSON.stringify([entry.name, entry.description, entry.revision ?? null])');
    source = replace(source, '\t\treadable.push({\n\t\t\tname,\n\t\t\tdescription\n\t\t});',
      '\t\treadable.push({\n\t\t\tname,\n\t\t\tdescription,\n\t\t\t...(typeof entry.revision === "string" ? { revision: entry.revision } : {})\n\t\t});');
    source = replace(source, 'const Config = z.object({ catalogDescriptionMaxLength:',
      'const Config = z.object({ catalogIndexMaxCharacters: z.number(), catalogDescriptionMaxLength:');
    source = replace(source, '\tconst catalogDescriptionMaxLength = config.catalogDescriptionMaxLength',
      '\tif (config.catalogIndexMaxCharacters !== undefined) assertPositiveInteger("catalogIndexMaxCharacters", config.catalogIndexMaxCharacters, 256);\n\tconst catalogDescriptionMaxLength = config.catalogDescriptionMaxLength');
    source = replace(source, '\t\tconst history = catalogHistory(agent);',
      '\t\tconst presentation = config.catalogIndexMaxCharacters !== undefined && ctx.tools.get("search_mcp_tools", agent)?.skillDiscoveryVersion === 1 ? `discovery-v1:${config.catalogIndexMaxCharacters}` : undefined;\n\t\tconst history = catalogHistory(agent);');
    source = replace(source, 'if (history.visibleDigest === digest)',
      'if (history.visibleDigest === digest && history.visiblePresentation === presentation)');
    source = replace(source, 'if (existing !== void 0 && digestCatalogEntries(existing.entries) === digest)',
      'if (existing !== void 0 && digestCatalogEntries(existing.entries) === digest && existing.message.source.presentation === presentation)');
    source = replace(source, 'history.published ? renderCatalogUpdate(entries) : renderCatalogMessage(entries)',
      'history.published ? renderCatalogUpdate(entries, presentation) : renderCatalogMessage(entries, presentation)');
    source = replace(source, '\t\t\tvisibleDigest: digest,',
      '\t\t\tvisibleDigest: digest,\n\t\t\tvisiblePresentation: event.data.source.presentation,');
    for (const [name, update] of [['renderCatalogMessage', false], ['renderCatalogUpdate', true]]) {
      source = replace(source, `function ${name}(entries) {`, `function ${name}(entries, presentation) {
\tif (presentation !== undefined) return createUserMessage({
\t\tcontent: [{type: "text", text: renderSkillIndex(entries, presentation, ${update})}],
\t\tsource: {kind: "skill-catalog", form: "catalog", entries, presentation${update ? ', update: true' : ''}}
\t});`);
    }
    return source;
  },
};
