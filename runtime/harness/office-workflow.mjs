// Deployment guidance for the pinned Office provider. Keep upstream authoring,
// validation and resource paths intact; no execution or completion policy lives here.
export function officeWorkflow(skill, imageInput) {
  if (skill?.provider !== 'dsh-office') return skill;
  const workflows = {
    'office-xlsx': 'Use openpyxl for existing workbooks, data_only=False to preserve formulas; never round-trip an existing workbook through pandas. Keep sheets, styles, formulas and cell types outside the requested change. For new files use short loops and only requested formatting. openpyxl does not calculate formulas: when cached results are needed run the installed CLI capabilities --json once, then recalculate --input draft.xlsx --output final.xlsx once. Check final formulas and cached values by reopening both data_only=False and True. Do not replace requested formulas with constants or trust stale caches. Recalculation is not business validation. Preserve macro/advanced features explicitly; never rename other formats to .xlsx.',
    'office-docx': 'Use python-docx. For existing documents inspect only affected paragraphs/tables and preservation requirements, edit runs when formatting must survive, and keep headers, footers, tables and unrelated content intact. Avoid assigning whole paragraph.text for a partial styled edit. Reopen the saved document and assert the requested text, structure and preservation. Complex tracked changes, layout or unsupported features require the full guide.',
    'office-pptx': 'Use python-pptx. Preserve the existing presentation and unrelated slides, shapes and formatting for edits. Check requested slide count, text and object structure by reopening the saved file. For complex layout, charts, images or rendering read the full guide; structural validation alone cannot establish visual quality.',
  };
  const workflow = workflows[skill.name];
  // Keep uncommon format/export guidance in its original read-only resource.
  // Only specialize the three pinned bundled skills, never third-party content.
  const runtimeStart = skill.content.indexOf('## Installed LibreOffice Kit');
  if (!workflow || runtimeStart < 0 || !skill.resourceBase?.path) return skill;
  const visual = imageInput === true
    ? 'The current model accepts images. Inspect requested layout using an available image tool; never use the text read tool for image bytes.'
    : imageInput === false
      ? 'The current model has no declared image input. Do not render previews solely for visual QA, read images with the text reader, count pixels as visual proof, or switch models. Validate data and document structure; disclose a requested visual check as unavailable. Still produce images/PDFs explicitly requested as deliverables.'
      : 'Before visual QA establish that image input and an image tool are available; otherwise skip inspection-only rendering and disclose the limitation.';
  return { ...skill, content: `# ${skill.name}: CodeBuddy workflow

Honor explicit user/project environment requirements. Otherwise call load_workspace_dependencies({}) once and reuse its bundled Python/libraries; do not install or discover another interpreter. Run standalone Office scripts with <python> -I -B -X utf8 task.py: isolated imports prevent task filenames from shadowing Python libraries, and UTF-8 preserves non-ASCII output. Explicit local helper modules need explicit imports; do not change project Python settings. Skill resources are read-only; keep task scripts and outputs in the workspace. Save a new output unless an in-place edit was requested.

${workflow}

Use write(file_path, content) for a concise task script, then run it with the shell. Correct an existing text script with edit(file_path, old_string, new_string) rather than resending the whole file; never use text edit on an Office binary. Do not embed a long script inside shell JSON: a parameter correction would resend all code. Shell calls need both description and command, e.g. pwsh({"description":"Run Office task and checks","command":"& '<python>' -I -B -X utf8 'task.py'"}); use bash on non-Windows. Replace placeholders with returned paths. Batch independent inspection and keep output to relevant values. Match checks to the user's requirements, not every library feature. Basic files do not need elaborate styling or a generic validation framework. Batch any necessary scratch cleanup with final validation instead of spending another round just on tidying.

Combine authoring and business assertions in the task script; when recalculation is required, run assertions on the recalculated file. Run the shared structural checker <python> -I -B -X utf8 <skill-directory>/../scripts/check_office.py <final-file> --out checks.json in the same shell call as relevant reopened-file assertions. Optional arguments: --contains 'expected text' (repeatable, not numeric/formula validation); --count 3 (integer sheet/slide count, never slides=3 or sheets=3). ZIP/XML success alone is insufficient. After correction rerun only affected checks. Do not write successive verification scripts to reconfirm unchanged passing results.

${visual}

Deliver verified outputs with [filename](relative/path), forward slashes and <...> for spaces. A Markdown link is its file delivery method; no present tool exists. Do not search for delivery tools. Report the requested result and genuine limits briefly. A failure, changed source or missing evidence justifies more work; these instructions do not declare completion or relax permissions.

For advanced formatting, macros, export or rendering read ${JSON.stringify(skill.resourceBase.path + '/SKILL.md')}. Its authoring details apply, but CodeBuddy delivery and current model capability above take precedence. Use only the installed LibreOffice unless explicitly opted out; report unavailable/failed operations without substituting another renderer. Do not render solely for data validation or retry blank previews. Requested exports remain deliverables.

${skill.content.slice(runtimeStart)}` };
}
