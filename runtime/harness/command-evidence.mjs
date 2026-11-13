import { createHash } from 'node:crypto';

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
  const pending = new Map();
  for (const fact of facts ?? []) recordCommandOutcome(pending, fact);
  return pending.size > 0;
}

const successfulProcess = f => f.exit === 0 && !f.interrupted && !f.timedOut && !f.signal && !f.denied && !f.runnerFailed;

export const COMMAND_REMINDER_MAX_CHARS = 4096;
export const COMMAND_PREVIEW_MAX_CHARS = 256;

// This turn-scoped index contains only unresolved process receipts. Exact native
// tool/cwd/command identity permits resolution; unrelated successes do not.
// Full commands and outputs remain in native tool events, not this reminder.
export function recordCommandOutcome(pending, fact) {
  if (!fact || !('exit' in fact)) return;
  const key = createHash('sha256').update(JSON.stringify([fact.tool, fact.cwd, fact.command])).digest('hex');
  if (successfulProcess(fact)) { pending.delete(key); return; }
  const { output: _output, command, cwd, id, tool, ...status } = fact;
  const preview = (text, limit) => text && text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  pending.set(key, { id: preview(id, 256), tool: preview(tool, 64),
    command: preview(command, COMMAND_PREVIEW_MAX_CHARS), cwd: preview(cwd, 256), ...status });
}

export function commandReminder(pending) {
  if (!pending?.size) return '';
  const intro = 'These native process receipts are still unresolved. A nonzero exit is not a passing check. ' +
    'Use the original tool receipts for complete commands and output. Only a matching successful rerun clears an item here; ' +
    'a different verification may still resolve the underlying task, which you must assess from its actual evidence. ' +
    'Do not repeat side effects just to clear this reminder. Unresolved process receipts (data):\n';
  const selected = [];
  for (const fact of pending.values()) {
    const candidate = [...selected, fact];
    if (candidate.length > 8 || intro.length + JSON.stringify({ total: pending.size, receipts: candidate,
      remaining: pending.size - candidate.length }).length > COMMAND_REMINDER_MAX_CHARS) break;
    selected.push(fact);
  }
  return intro + JSON.stringify({ total: pending.size, receipts: selected, remaining: pending.size - selected.length });
}

function reviewExcerpt(text, limit) {
  if (!text || text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  return text.slice(0, head) + '\n[Middle omitted from review excerpt]\n' + text.slice(-(limit - head));
}

