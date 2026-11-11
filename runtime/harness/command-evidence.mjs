// A tool invocation may succeed while its foreground process exits nonzero.
// Only the native definition's structured result can establish these facts.
export function commandEvidence(exec, result, { native = true } = {}) {
  if (result.isError) {
    if (!native) return;
    return { id: exec.callId, tool: exec.name, kind: 'tool', failed: true,
      input: reviewExcerpt(JSON.stringify(exec.arguments), 2000),
      output: reviewExcerpt(JSON.stringify({ error: { name: result.error?.name,
        code: result.error?.code, message: result.error?.message }, content: result.content, value: result.value }), 8000) };
  }
  const value = result.value;
  if (native && ['pwsh', 'bash'].includes(exec.name) && value?.kind === 'foreground') {
    return { id: exec.callId, tool: exec.name, command: exec.arguments.command, cwd: value.cwd,
      exit: value.exitCode, interrupted: Boolean(value.aborted), timedOut: Boolean(value.timedOut),
      signal: value.signal, denied: Boolean(value.sandbox?.denied), runnerFailed: Boolean(value.sandbox?.runnerFailed),
      output: reviewExcerpt([value.stdout?.text, value.stderr?.text].filter(Boolean).join('\n'), 4000) };
  }
  if (native && ['write', 'edit'].includes(exec.name) && typeof value?.path === 'string')
    return { id: exec.callId, tool: exec.name, path: value.path,
      content: reviewExcerpt(exec.arguments?.content ?? exec.arguments?.new_string, 6000) };
  // Native reads, empty searches and job acknowledgements are observations too.
  // Keep their structured result without promoting a target path to a file change
  // or a cancellation request to proof that a process has already stopped.
  if (native) return { id: exec.callId, tool: exec.name, kind: 'tool',
    input: reviewExcerpt(JSON.stringify(exec.arguments), 2000),
    output: reviewExcerpt(JSON.stringify({ value, content: result.content }), 8000) };
  // Non-process receipts prove only the returned observation, not arbitrary
  // success claims. Do not promote their tool-level success to process exit 0.
  if (!native && value && !value.isError) {
    const output = Array.isArray(value.content)
      ? value.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      : JSON.stringify(value);
    return { id: exec.callId, tool: exec.name, kind: 'tool',
      operation: exec.arguments?.operation, input: reviewExcerpt(JSON.stringify(exec.arguments), 2000), output: reviewExcerpt(output, 8000) };
  }
}

export function hasFailedCommand(facts) {
  return facts?.some(f => 'exit' in f && !successfulProcess(f));
}

const successfulProcess = f => f.exit === 0 && !f.interrupted && !f.timedOut && !f.signal && !f.denied && !f.runnerFailed;

function reviewExcerpt(text, limit) {
  if (!text || text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  return text.slice(0, head) + '\n[Middle omitted from review excerpt]\n' + text.slice(-(limit - head));
}

