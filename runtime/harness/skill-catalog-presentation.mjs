// Presentation only: the native plugin retains the complete durable entries,
// catalog identity, invocation rules and skill loading/approval pipeline.
export function renderSkillIndex(entries, presentation, update = false) {
  if (!entries.length) return '<system-reminder>No skills are currently available through the skill tool. Do not use names from earlier catalogs. A directly supplied <skill_content> remains applicable without calling skill again.</system-reminder>';
  const budget = Number(presentation.split(':')[1]);
  const lines = [];
  let size = 0;
  for (const entry of entries) {
    const description = entry.description.replace(/\s+/g, ' ').slice(0, 90)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const line = `- ${entry.name}: ${description}`;
    if (size + line.length + 1 > budget) break;
    lines.push(line);
    size += line.length + 1;
  }
  return [
    '<system-reminder>',
    `${update ? 'Updated skill index. ' : ''}${entries.length} skills available; ${lines.length} summaries shown. This index may be partial.`,
    ...(update ? ['Skill content or availability changed. Reload previously loaded skills before relying on them; do not reuse older instructions.'] : []),
    ...lines,
    'For tasks that may benefit from skills, search_mcp_tools({kind:"skills",query:"task keywords"}) returns current summaries. Empty query with offset browses all permitted skills. Search uses names/descriptions; use alternate keywords or browse if no match. Missing from this index does not mean unavailable.',
    'If the user names a skill, or a task matches its description, call skill({name:"exact-name"}) before acting. Load all applicable skills and follow their full instructions; summaries are not instructions. If its <skill_content> is already provided by a direct user invocation, follow it without loading again.',
    '</system-reminder>',
  ].join('\n');
}
