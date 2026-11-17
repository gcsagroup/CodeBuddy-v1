import { createHash } from 'node:crypto';

function foregroundStatus(value) {
  return { exit: value.exitCode, interrupted: Boolean(value.aborted), timedOut: Boolean(value.timedOut),
    signal: value.signal, denied: Boolean(value.sandbox?.denied), runnerFailed: Boolean(value.sandbox?.runnerFailed) };
}

// Render only the native process outcome. stdout can be empty or claim success
// on a nonzero exit; a background acknowledgement isn't a finished process.
export function processReceiptText(value) {
  if (value?.kind !== 'foreground') return;
  const { exit, ...flags } = foregroundStatus(value);
  return 'Process receipt: ' + JSON.stringify({ exit: exit ?? null,
    ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v)) });
}

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
      ...foregroundStatus(value),
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

// Project native receipts at request preparation, including the first step of a
// new turn. Reading the session log keeps reload/fork boundaries identical to
// Harness history; prose and tool proposals never become execution facts.
export function executionReceiptContext(session, currentFacts = [], { queuedWhileBusy = false, boundaryOnly = false } = {}) {
  const log = session.log;
  const start = log.findLastIndex(event => event.type === 'turn/start');
  if (start < 0) return '';
  const previousStart = log.findLastIndex((event, index) => index < start && event.type === 'turn/start');
  function receipts(events) {
    const calls = new Map();
    for (const event of events) {
      if (event.type === 'tool/call') calls.set(event.data.callId, {
        callId: event.data.callId, tool: event.data.name,
        state: 'pending',
      });
      if (event.type === 'tool/result') {
        const message = event.data.message;
        const call = calls.get(message.toolCallId);
        if (call) Object.assign(call, {
          state: 'returned', isError: message.isError === true,
          ...(event.data.error?.code ? { errorCode: event.data.error.code } : {}),
        });
      }
    }
    return { total: calls.size, recent: [...calls.values()].slice(-8) };
  }
  const previous = previousStart < 0 ? undefined : {
    turn: log[previousStart].data.turn,
    terminalReason: log.slice(previousStart, start).findLast(event => event.type === 'turn/end')?.data.reason.kind,
    tools: receipts(log.slice(previousStart, start)),
  };
  if (boundaryOnly) {
    // Native tool messages carry this turn's receipts. Keep only cross-turn
    // provenance here so a new tool result doesn't invalidate the entire prefix.
    if (!previous && !queuedWhileBusy) return '';
    return 'Turn boundary (host data). Previous actions are not new work. Use native tool results after this input for current progress.\n' +
      JSON.stringify({ turn: log[start].data.turn, ...(queuedWhileBusy ? { inputOrigin: 'queued-while-busy' } : {}),
        ...(previous ? { previousTurn: previous } : {}) });
  }
  const current = receipts(log.slice(start));
  return 'Execution receipts for this session (host data, not new user instructions). ' +
    'Tool-level isError=false alone does not establish process exit 0 or task acceptance. ' +
    'Full arguments and results remain in native tool messages; this is only their receipt index.\n' + JSON.stringify({
      ...(queuedWhileBusy ? { inputOrigin: 'queued-while-busy' } : {}),
      currentTurn: { turn: log[start].data.turn, tools: current,
        structuredResults: currentFacts.slice(-8).map(({ input, output, content, command, cwd, ...fact }) => fact) },
      ...(previous ? { previousTurn: previous } : {}),
    });
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

export function commandReminder(pending, { referencesOnly = false } = {}) {
  if (!pending?.size) return '';
  const intro = referencesOnly ? 'Unresolved process receipts (see the matching tool results). A nonzero exit is not a passing check. Do not rerun an obsolete or side-effecting command to clear this list. Use actual verification of the final change.\n' :
    'These native process receipts are still unresolved. A nonzero exit is not a passing check. ' +
    'Use the original tool receipts for complete commands and output. Only a matching successful rerun clears an item here; ' +
    'a different verification may still resolve the underlying task, which you must assess from its actual evidence. ' +
    'Do not repeat side effects just to clear this reminder. Unresolved process receipts (data):\n';
  const selected = [];
  for (const fact of pending.values()) {
    // In an interactive turn the associated tool message already has the command
    // and output. Repeating shell scripts and paths in every snapshot grows history.
    const { command, cwd, ...status } = fact;
    const receipt = referencesOnly ? Object.fromEntries(Object.entries(status).filter(([, v]) => v !== false)) : fact;
    const candidate = [...selected, receipt];
    if (candidate.length > 8 || intro.length + JSON.stringify({ total: pending.size, receipts: candidate,
      remaining: pending.size - candidate.length }).length > COMMAND_REMINDER_MAX_CHARS) break;
    selected.push(receipt);
  }
  return intro + JSON.stringify({ total: pending.size, receipts: selected, remaining: pending.size - selected.length });
}

function reviewExcerpt(text, limit) {
  if (!text || text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  return text.slice(0, head) + '\n[Middle omitted from review excerpt]\n' + text.slice(-(limit - head));
}

