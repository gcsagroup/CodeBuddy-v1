import type { IntlShape } from 'react-intl';
import { defineMessages } from '../i18n';
import { snakeToTitleCase } from '../utils';
import type { ToolResponseMessageContent } from '../types/message';

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
  webSearch: { id: 'toolAction.webSearch', defaultMessage: 'Search the web' },
  webSearchRunning: { id: 'toolAction.webSearchRunning', defaultMessage: 'Searching the web' },
  webSearchDone: { id: 'toolAction.webSearchDone', defaultMessage: 'Searched the web' },
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
    defaultMessage: 'Completed {count, plural, one {# operation} other {# operations}}',
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
      name === 'read_document' || name === 'read'
        ? 'read'
        : name === 'write' || name === 'edit' || name === 'shell'
          ? name
          : name === 'pwsh' || name === 'bash'
            ? 'shell'
            : 'other';
    if (name === 'text_editor') {
      if (call.arguments.command === 'view') kind = 'read';
      else if (call.arguments.command === 'write') kind = 'write';
      else if (call.arguments.command === 'str_replace' || call.arguments.command === 'insert')
        kind = 'edit';
    }
    const path =
      typeof call.arguments.file_path === 'string'
        ? call.arguments.file_path.trim()
        : typeof call.arguments.path === 'string'
          ? call.arguments.path.trim()
          : '';
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
  if (isWebSearchTool(fullName)) {
    return intl.formatMessage(
      messages[
        state === 'running'
          ? 'webSearchRunning'
          : state === 'completed'
            ? 'webSearchDone'
            : 'webSearch'
      ]
    );
  }
  let action: keyof typeof messages | undefined;
  let target = '';
  const fileAction = (kind: 'read' | 'write' | 'edit') => {
    action = kind;
    const path = args.file_path ?? args.path;
    if (typeof path === 'string') target = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
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
    case 'read':
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
    case 'pwsh':
    case 'bash':
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

// Tool identities select a view; query/result prose never decides the operation or its status.
export function isWebSearchTool(fullName: string): boolean {
  const name = fullName.split(/__|::/).pop();
  return [
    'web_search',
    'web_search_exa',
    'web_search_exa_advanced',
    'search_web',
    'brave_web_search',
    'tavily_search',
    'bing_search',
    'google_search',
    'duckduckgo_search',
    'exa_search',
  ].includes(name ?? '');
}

export function toolFilePath(name: string, args: Record<string, unknown>): string | undefined {
  const tool = name.split(/__|::/).pop();
  if (!['read', 'read_document', 'write', 'edit', 'text_editor'].includes(tool ?? '')) return;
  if (
    tool === 'text_editor' &&
    !['view', 'write', 'str_replace', 'insert'].includes(String(args.command))
  )
    return;
  const path = args.file_path ?? args.path;
  return typeof path === 'string' && path.trim() ? path : undefined;
}

export function webSearchDetails(
  args: Record<string, unknown>,
  response?: ToolResponseMessageContent
): { queries: string[]; sources: { title: string; url: string }[]; notice?: string } {
  const queries = [
    args.query,
    args.search_query,
    ...(Array.isArray(args.queries) ? args.queries : []),
  ].filter((value): value is string => typeof value === 'string' && !!value.trim());
  const sources = new Map<string, { title: string; url: string }>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== 'string' || sources.size >= 100) return;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        return;
      sources.set(parsed.href, {
        url: parsed.href,
        title: typeof title === 'string' && title.trim() ? title.trim() : parsed.href,
      });
    } catch {
      /* A malformed source remains unlinked. */
    }
  };
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const noticeOf = (input: unknown): string | undefined => {
    if (record(input)) {
      const error = record(input.error) ? input.error.message : input.error;
      return typeof error === 'string'
        ? error
        : typeof input.message === 'string'
          ? input.message
          : undefined;
    }
    if (typeof input !== 'string') return;
    try {
      const parsed: unknown = JSON.parse(input);
      if (!record(parsed)) return;
      const error = record(parsed.error) ? parsed.error.message : parsed.error;
      return typeof error === 'string'
        ? error
        : typeof parsed.message === 'string'
          ? parsed.message
          : undefined;
    } catch {
      if (input.trim().startsWith('{') || input.trim().startsWith('[')) return;
      return input
        .trim()
        .split(/\n\s*\n/)[0]
        .slice(0, 1500);
    }
  };
  const structured = (value: unknown, depth = 0) => {
    if (depth > 4) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((item) => structured(item, depth + 1));
      return;
    }
    if (!record(value)) return;
    add(value.url ?? value.link, value.title ?? value.name);
    for (const key of ['results', 'sources', 'items', 'web', 'data', 'organic'])
      structured(value[key], depth + 1);
  };
  const result = response?.toolResult;
  const value = result?.status === 'success' && record(result.value) ? result.value : undefined;
  structured(value?.structuredContent ?? response?.metadata?.rawOutput);
  let notice =
    result?.status === 'error'
      ? noticeOf(result.error)
      : value?.isError === true
        ? noticeOf(value.structuredContent ?? response?.metadata?.rawOutput)
        : undefined;
  for (const block of Array.isArray(value?.content) ? value.content : []) {
    if (!record(block)) continue;
    const audience = record(block.annotations) ? block.annotations.audience : undefined;
    if (Array.isArray(audience) && !audience.includes('user')) continue;
    if (block.type === 'resource_link') add(block.uri, block.name);
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    try {
      const parsed: unknown = JSON.parse(text);
      structured(parsed);
      if (!notice && !sources.size) notice = noticeOf(parsed);
    } catch {
      // Some MCP tools publish source records as labelled text instead of JSON.
      // Only their explicit Title/URL fields become source links, never prose URLs.
      for (const source of text.matchAll(/^Title: ([^\r\n]+)\r?\nURL: (\S+)\s*$/gm))
        add(source[2], source[1]);
      if (!notice && !sources.size) notice = noticeOf(text);
    }
  }
  return {
    queries: [...new Set(queries)],
    sources: [...sources.values()],
    ...(notice && !sources.size ? { notice } : {}),
  };
}
