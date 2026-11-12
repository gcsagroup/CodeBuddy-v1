import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

// Only the active native tool call may publish its own lookup outcome.
export const projectScriptCall = new AsyncLocalStorage();

// A filename mention only nominates a request for interpretation. The model
// selects standalone execution from the human messages, before seeing any file
// listing, tool output, or another project's similarly named scripts.
export async function selectNamedScript(ctx, agent, input, signal) {
  const selection = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
  const route = selection?.pending ?? selection?.lastUsed ?? agent.session.requestHeader()?.config ?? agent.options;
  const call = await ctx.llm.prepareCall({provider:route.provider,model:route.model,maxTokens:768}, signal,
    (controls, model) => ({...controls, ...(model.reasoning?.efforts?.[0]?.id ? {reasoningEffort:model.reasoning.efforts[0].id} : {})}));
  const output = {name:'select_project_script',description:'Record the requested operation without executing it.',
    parameters:{type:'object',properties:{mode:{enum:['run_only','other']},path:{type:'string'}},required:['mode','path'],additionalProperties:false}};
  const assembler = new BlockAssembler();
  for await (const chunk of call.stream({...call.config, signal, tools:[output],
    system:'Interpret the human request. Return exactly one select_project_script call. Select run_only when the user asks to execute one explicitly named existing project .ps1 script, including reporting its output, exit status, or filename. Copy the exact filename or relative path from the user, retaining spaces, spelling and punctuation. A later correction supersedes an earlier one. Select other with empty path for explanations, negation, hypothetical requests, creation, edits, multiple scripts, explicit external paths, script arguments, separately requested follow-up actions, or when no single target is identified. Never substitute a synonym or invent a path.',
    messages:[createUserMessage({content:[{type:'text',text:JSON.stringify(input)}],source:{kind:'codebuddy-script-selection'}})]})) assembler.push(chunk);
  signal?.throwIfAborted();
  const blocks = assembler.blocks().filter(b=>b.type==='tool-call');
  if (!['stop','tool-calls'].includes(assembler.finish?.kind) || blocks.length !== 1 || blocks[0].name !== output.name)
    throw new Error('The model did not return a project script selection.');
  const decision = JSON.parse(blocks[0].arguments);
  if (decision.mode === 'other') return null;
  if (decision.mode !== 'run_only' || typeof decision.path !== 'string' || !decision.path.toLowerCase().endsWith('.ps1') ||
      !input.some(text=>text.includes(decision.path))) throw new Error('The selected script is not an exact filename from this request.');
  return decision.path;
}

// Parse the host-provided command's literal argument, never user chat text.
// Shell expressions are deliberately not evaluated when resolving a filename.
const invocation = /^\s*Invoke-CodeBuddyProjectScript\s+-LiteralPath\s+(?:'((?:[^']|'')*)'|"([^"$`\r\n]*)"|([^\s;&|$`'"()]+))(?:\s+(-ContinueTask))?(?:\s+(-ArgumentList\s+[^\r\n]+))?\s*;?\s*$/i;
export function projectScriptInvocation(command) {
  if (!/^\s*Invoke-CodeBuddyProjectScript\b/i.test(command)) return;
  const match = invocation.exec(command);
  if (!match) throw new Error('Use a standalone Invoke-CodeBuddyProjectScript -LiteralPath with the exact quoted project-relative filename.');
  const args = [];
  if (match[5]) {
    let remaining = match[5].replace(/^-ArgumentList\s+/i, '').trimEnd();
    for (;;) {
      const part = /^(?:'((?:[^']|'')*)'|"([^"$`\r\n]*)"|([\w.-]+))\s*(,|$)/u.exec(remaining);
      if (!part) throw new Error('Use comma-separated literal values for -ArgumentList.');
      args.push(part[1]?.replaceAll("''", "'") ?? part[2] ?? part[3]);
      if (!part[4]) break;
      remaining = remaining.slice(part[0].length).trimStart();
    }
  }
  return { name: match[1]?.replaceAll("''", "'") ?? match[2] ?? match[3], args, continueTask: Boolean(match[4]) };
}

export async function resolveProjectScript(root, name, signal, workdir = root) {
  const parts = name.split(/[\\/]/);
  const qualified = parts.length > 1;
  if (parts[0] === '.') parts.shift();
  if (path.isAbsolute(name) || parts.some(p => !p || /[<>:"|?*\x00-\x1f]/.test(p) || /[ .]$/.test(p)) ||
      path.extname(name).toLowerCase() !== '.ps1')
    return { status: 'invalid', name, detail: 'Invalid project-relative .ps1 path: ' + name };
  const outside = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  };
  const wrongDirectory = { status: 'invalid', name, detail: 'The script working directory is outside this project: ' + workdir };
  if (outside(root, workdir)) return wrongDirectory;
  const workspace = await realpath(root);
  if (path.relative(root,workdir) && outside(workspace, await realpath(workdir))) return wrongDirectory;
  const sameName = (a,b) => a.toLowerCase() === b.toLowerCase();
  const matches = [];
  const scan = async (dir, target, descend) => {
    signal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });
    // Recursive basename lookup stops at a nested checkout. An explicitly
    // supplied relative directory is resolved component by component above it.
    if (descend && dir !== workspace && entries.some(entry => entry.name === '.git')) return;
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && sameName(entry.name,target)) matches.push(file);
      if (descend && entry.isDirectory() && entry.name !== '.git') descend.push(file);
    }
  };
  if (qualified) {
    let dir = workspace;
    for (const part of parts.slice(0,-1)) {
      signal?.throwIfAborted();
      const entry = (await readdir(dir,{withFileTypes:true})).find(e=>sameName(e.name,part));
      if (!entry?.isDirectory()) return missing();
      dir = path.join(dir,entry.name);
    }
    await scan(dir, parts.at(-1));
  } else {
    const pending = [];
    await scan(workspace,name,pending);
    // A file at the project root takes precedence over a recursive basename lookup.
    if (!matches.length) while (pending.length) await scan(pending.pop(),name,pending);
  }
  if (!matches.length) return missing();
  if (matches.length !== 1) return {status:'ambiguous',name,
    detail:'Multiple project files named ' + name + '; specify a relative path: ' + matches.map(p=>path.relative(workspace,p)).sort().join(', ')};
  const selected = await realpath(matches[0]);
  if (outside(workspace,selected)) return missing();
  return {status:'found',name,path:selected};

  function missing() { return {status:'missing',name,detail:'File not found in this project: ' + name}; }
}
