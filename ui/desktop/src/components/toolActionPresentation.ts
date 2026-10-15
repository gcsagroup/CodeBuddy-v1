import type { IntlShape } from 'react-intl';
import { defineMessages } from '../i18n';
import { snakeToTitleCase } from '../utils';

const messages = defineMessages({
  readDone: { id: 'toolAction.readDone', defaultMessage: 'Read file' },
  writeDone: { id: 'toolAction.writeDone', defaultMessage: 'Wrote file' },
  writeRunning: { id: 'toolAction.writeRunning', defaultMessage: 'Writing file{target}' },
  generatingFileHeadline: {
    id: 'toolAction.generatingFileHeadline',
    defaultMessage: 'Generating file contents{target} — not saved yet',
  },
  editDone: { id: 'toolAction.editDone', defaultMessage: 'Edited file' },
  shellDone: { id: 'toolAction.shellDone', defaultMessage: 'Ran command' },
  running: { id: 'toolAction.running', defaultMessage: '{action} · in progress' },
  generating: {
    id: 'toolAction.generating',
    defaultMessage: 'Preparing operation parameters{target}',
  },
  generatingFile: {
    id: 'toolAction.generatingFile',
    defaultMessage: 'Generating {target} · {count} lines received — not saved yet',
  },
  read: { id: 'toolAction.read', defaultMessage: 'Read file' },
  write: { id: 'toolAction.write', defaultMessage: 'Write file' },
  edit: { id: 'toolAction.edit', defaultMessage: 'Edit file' },
  search: { id: 'toolAction.search', defaultMessage: 'Search' },
  tree: { id: 'toolAction.tree', defaultMessage: 'List files' },
  shell: { id: 'toolAction.shell', defaultMessage: 'Run command' },
  observe: { id: 'toolAction.observe', defaultMessage: 'Observe desktop' },
  screenshot: { id: 'toolAction.screenshot', defaultMessage: 'Capture screenshot' },
  mouse: { id: 'toolAction.mouse', defaultMessage: 'Click in window' },
  keyboard: { id: 'toolAction.keyboard', defaultMessage: 'Use keyboard' },
  type: { id: 'toolAction.type', defaultMessage: 'Enter text' },
  code: { id: 'toolAction.code', defaultMessage: 'Execute code' },
  delegate: { id: 'toolAction.delegate', defaultMessage: 'Delegate work' },
  takeover: { id: 'toolAction.takeover', defaultMessage: 'Take over unfinished delegated work' },
  result: { id: 'toolAction.result', defaultMessage: 'Present result' },
  contract: { id: 'toolAction.contract', defaultMessage: 'Check task requirements' },
  contractInspect: { id: 'toolAction.contractInspect', defaultMessage: 'View task requirements' },
  contractRevise: { id: 'toolAction.contractRevise', defaultMessage: 'Update task requirements' },
  contractCoverage: {
    id: 'toolAction.contractCoverage',
    defaultMessage: 'Check delivery evidence',
  },
  other: { id: 'toolAction.other', defaultMessage: 'Use tool {name}' },
  move: { id: 'toolAction.move', defaultMessage: 'Move pointer' },
  drag: { id: 'toolAction.drag', defaultMessage: 'Drag in window' },
  scroll: { id: 'toolAction.scroll', defaultMessage: 'Scroll in window' },
  completed: { id: 'toolAction.completed', defaultMessage: 'Tool call completed' },
  readSummary: {
    id: 'toolAction.readSummary',
    defaultMessage: 'Read {count, plural, one {# file} other {# files}}',
  },
  writeSummary: {
    id: 'toolAction.writeSummary',
    defaultMessage: 'Wrote {count, plural, one {# file} other {# files}}',
  },
  editSummary: {
    id: 'toolAction.editSummary',
    defaultMessage: 'Edited {count, plural, one {# file} other {# files}}',
  },
  shellSummary: {
    id: 'toolAction.shellSummary',
    defaultMessage: 'Ran {count, plural, one {# command} other {# commands}}',
  },
  otherSummary: {
    id: 'toolAction.otherSummary',
    defaultMessage: 'Completed {count, plural, one {# other operation} other {# other operations}}',
  },
});

// Presentation only: these operations manage requirements/evidence, not user artifacts.
// Unknown operations retain ordinary tool status instead of being silently grouped here.
export function isTaskContractCheck(call: {
  name: string;
  arguments: Record<string, unknown>;
}): boolean {
  return (
    call.name.split(/__|::/).pop() === 'task_contract' &&
    ['inspect', 'revise', 'propose_coverage'].includes(String(call.arguments.operation))
  );
}

// Callers supply only successful receipts. File counts describe distinct paths,
// not the number of writes; missing paths remain operations, never invented files.
export function formatToolActionSummary(
  intl: IntlShape,
  calls: { name: string; arguments: Record<string, unknown> }[]
): string {
  type Kind = 'read' | 'write' | 'edit' | 'shell' | 'other';
  const groups = new Map<Kind, { paths: Set<string>; count: number }>();
  for (const call of calls) {
    const name = call.name.split(/__|::/).pop();
    let kind: Kind =
      name === 'read_document'
        ? 'read'
        : name === 'write' || name === 'edit' || name === 'shell'
          ? name
          : 'other';
    if (name === 'text_editor') {
      if (call.arguments.command === 'view') kind = 'read';
      else if (call.arguments.command === 'write') kind = 'write';
      else if (call.arguments.command === 'str_replace' || call.arguments.command === 'insert')
        kind = 'edit';
    }
    const path = typeof call.arguments.path === 'string' ? call.arguments.path.trim() : '';
    if ((kind === 'read' || kind === 'write' || kind === 'edit') && !path) kind = 'other';
    const group = groups.get(kind) ?? { paths: new Set<string>(), count: 0 };
    if (kind === 'read' || kind === 'write' || kind === 'edit')
      group.paths.add(path.replace(/\\/g, '/'));
    else group.count += 1;
    groups.set(kind, group);
  }
  return [...groups]
    .map(([kind, group]) =>
      intl.formatMessage(messages[`${kind}Summary`], {
        count: group.paths.size || group.count,
      })
    )
    .join(' ');
}

export function formatToolAction(
  intl: IntlShape,
  fullName: string,
  args: Record<string, unknown>,
  state?: 'running' | 'completed',
  presentation: 'detail' | 'headline' = 'detail'
): string {
  const name = fullName.split(/__|::/).pop() ?? fullName;
  let action: keyof typeof messages | undefined;
  let target = '';
  const fileAction = (kind: 'read' | 'write' | 'edit') => {
    action = kind;
    if (typeof args.path === 'string')
      target = args.path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  };
  switch (name) {
    case 'task_contract':
      action =
        args.operation === 'inspect'
          ? 'contractInspect'
          : args.operation === 'revise'
            ? 'contractRevise'
            : args.operation === 'propose_coverage'
              ? 'contractCoverage'
              : 'contract';
      break;
    case 'read_document':
      fileAction('read');
      break;
    case 'write':
      fileAction('write');
      break;
    case 'edit':
      fileAction('edit');
      break;
    case 'text_editor':
      if (args.command === 'view') fileAction('read');
      else if (args.command === 'write') fileAction('write');
      else if (args.command === 'str_replace' || args.command === 'insert') fileAction('edit');
      break;
    case 'shell':
      action = 'shell';
      if (presentation === 'detail' && typeof args.command === 'string')
        target = args.command.split(/\r?\n/)[0];
      break;
    case 'tree':
      action = 'tree';
      break;
    case 'search':
    case 'computer_search_ui':
      action = 'search';
      break;
    case 'computer_observe':
    case 'computer_observe_ui':
    case 'computer_inspect_ui':
    case 'computer_read_screen_text':
      action = 'observe';
      break;
    case 'computer_screenshot':
    case 'screen_capture':
      action = 'screenshot';
      break;
    case 'computer_click':
      action = 'mouse';
      break;
    case 'computer_move':
      action = 'move';
      break;
    case 'computer_drag':
      action = 'drag';
      break;
    case 'computer_scroll':
      action = 'scroll';
      break;
    case 'computer_key':
      action = 'keyboard';
      break;
    case 'computer_type':
      action = 'type';
      break;
    case 'execute_typescript':
    case 'automation_script':
      action = 'code';
      break;
    case 'delegate':
    case 'delegate_readonly':
      action = 'delegate';
      break;
    case 'take_over':
      action = 'takeover';
      break;
    case 'final_output':
      action = 'result';
      break;
  }
  if (!action) return intl.formatMessage(messages.other, { name: snakeToTitleCase(name) });
  const compactTarget = target.replace(/\s+/g, ' ').trim();
  const visibleTarget =
    compactTarget.length > 80 ? compactTarget.slice(0, 77) + '…' : compactTarget;
  if (presentation === 'headline' && action === 'write' && state === 'running') {
    return intl.formatMessage(
      args.__inputPreview === true ? messages.generatingFileHeadline : messages.writeRunning,
      { target: visibleTarget ? ` ${visibleTarget}` : '' }
    );
  }
  if (args.__inputPreview === true && state === 'running') {
    const content = action === 'write' ? args.content : action === 'edit' ? args.after : undefined;
    if (visibleTarget && typeof content === 'string' && content.length > 0) {
      return intl.formatMessage(messages.generatingFile, {
        target: visibleTarget,
        count: content.split('\n').length - (content.endsWith('\n') ? 1 : 0),
      });
    }
    return intl.formatMessage(messages.generating, {
      target: ` · ${[intl.formatMessage(messages[action]), visibleTarget].filter(Boolean).join(' ')}`,
    });
  }
  if (state === 'completed') {
    if (action === 'read') action = 'readDone';
    else if (action === 'write') action = 'writeDone';
    else if (action === 'edit') action = 'editDone';
    else if (action === 'shell') action = 'shellDone';
  }
  const label = [intl.formatMessage(messages[action]), visibleTarget].filter(Boolean).join(' ');
  return state === 'running' ? intl.formatMessage(messages.running, { action: label }) : label;
}

export function formatToolCompleted(intl: IntlShape): string {
  return intl.formatMessage(messages.completed);
}
