import type { IntlShape } from 'react-intl';
import { defineMessages } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { snakeToTitleCase } from '../utils';
import type { ToolResponseMessageContent } from '../types/message';
import { generatedMediaReceipt, mediaDisplayName } from '../utils/mediaToolReceipt';

const messages = defineMessages({
  readDone: { id: 'toolAction.readDone', defaultMessage: 'Read file' },
  writeDone: { id: 'toolAction.writeDone', defaultMessage: 'Wrote file' },
  writeRunning: { id: 'toolAction.writeRunning', defaultMessage: 'Writing file{target}' },
  generatingFileHeadline: {
    id: 'toolAction.generatingFileHeadline',
    defaultMessage: 'Generating file contents{target}',
  },
  editDone: { id: 'toolAction.editDone', defaultMessage: 'Edited file' },
  shellDone: { id: 'toolAction.shellDone', defaultMessage: 'Ran command' },
  running: { id: 'toolAction.running', defaultMessage: 'Running: {action}' },
  actionDone: { id: 'toolAction.actionDone', defaultMessage: 'Completed: {action}' },
  generating: {
    id: 'toolAction.generating',
    defaultMessage: 'Preparing operation parameters{target}',
  },
  generatingFile: {
    id: 'toolAction.generatingFile',
    defaultMessage: 'Generating {target}, {count} lines received — not saved yet',
  },
  read: { id: 'toolAction.read', defaultMessage: 'Read file' },
  write: { id: 'toolAction.write', defaultMessage: 'Write file' },
  edit: { id: 'toolAction.edit', defaultMessage: 'Edit file' },
  search: { id: 'toolAction.search', defaultMessage: 'Search' },
  webSearch: { id: 'toolAction.webSearch', defaultMessage: 'Search the web' },
  webSearchRunning: { id: 'toolAction.webSearchRunning', defaultMessage: 'Searching the web' },
  webSearchDone: { id: 'toolAction.webSearchDone', defaultMessage: 'Searched the web' },
  browserAction: {
    id: 'toolConfirmation.browserAction',
    defaultMessage:
      '{operation, select, open {Open page} observe {Read page} click {Click page element} type {Enter text on page} key {Send key to page} screenshot {Capture page} console {Read page console} close {Close page} other {Browser action}}',
  },
  tree: { id: 'toolAction.tree', defaultMessage: 'List files' },
  shell: { id: 'toolAction.shell', defaultMessage: 'Run command' },
  observe: { id: 'toolAction.observe', defaultMessage: 'Observe desktop' },
  screenshot: { id: 'toolAction.screenshot', defaultMessage: 'Capture screenshot' },
  mouse: { id: 'toolAction.mouse', defaultMessage: 'Click in window' },
  keyboard: { id: 'toolAction.keyboard', defaultMessage: 'Use keyboard' },
  type: { id: 'toolAction.type', defaultMessage: 'Enter text' },
  windows: { id: 'toolAction.windows', defaultMessage: 'List open windows' },
  window: { id: 'toolAction.window', defaultMessage: 'Read window contents' },
  control: { id: 'toolAction.control', defaultMessage: 'Interact with a window control' },
  value: { id: 'toolAction.value', defaultMessage: 'Fill in a field' },
  discover: { id: 'toolAction.discover', defaultMessage: 'Find available tools' },
  findFiles: { id: 'toolAction.findFiles', defaultMessage: 'Find files' },
  searchContents: { id: 'toolAction.searchContents', defaultMessage: 'Search file contents' },
  readImage: { id: 'toolAction.readImage', defaultMessage: 'View an image' },
  createAgent: { id: 'toolAction.createAgent', defaultMessage: 'Create a subagent' },
  sourceResearch: { id: 'subagentTemplates.browser', defaultMessage: 'Web research' },
  messageAgent: { id: 'toolAction.messageAgent', defaultMessage: 'Send a message to a subagent' },
  listAgents: { id: 'toolAction.listAgents', defaultMessage: 'Check subagent progress' },
  skill: { id: 'toolAction.skill', defaultMessage: 'Load task instructions' },
  workingDirectory: {
    id: 'toolAction.workingDirectory',
    defaultMessage: 'Check the working folder',
  },
  dependencies: {
    id: 'toolAction.dependencies',
    defaultMessage: 'Locate available document tools',
  },
  fetch: { id: 'toolAction.fetch', defaultMessage: 'Read webpage contents' },
  crawl: { id: 'toolAction.crawl', defaultMessage: 'Read pages across a website' },
  siteMap: { id: 'toolAction.siteMap', defaultMessage: 'Find pages on a website' },
  research: { id: 'toolAction.research', defaultMessage: 'Research a topic online' },
  time: { id: 'toolAction.time', defaultMessage: 'Check the current time' },
  location: { id: 'toolAction.location', defaultMessage: 'Find a location' },
  weather: { id: 'toolAction.weather', defaultMessage: 'Check the weather' },
  diagram: { id: 'toolAction.diagram', defaultMessage: 'Draw a diagram' },
  chart: { id: 'toolAction.chart', defaultMessage: 'Create a chart' },
  map: { id: 'toolAction.map', defaultMessage: 'Create a map' },
  generateImage: { id: 'toolAction.generateImage', defaultMessage: 'Generate an image' },
  generateVideo: { id: 'toolAction.generateVideo', defaultMessage: 'Generate a video' },
  mediaOperation: {
    id: 'toolAction.mediaOperation',
    defaultMessage:
      '{kind, select, video {Video generation} other {Image generation}} · {operation, select, inspect {Workflow inspection} generate {Submission request} status {Status check} cancel {Cancellation request} other {Tool operation}}',
  },
  mediaJobStatus: {
    id: 'toolAction.mediaJobStatus',
    defaultMessage:
      '{status, select, preparing {Preparing} submission_unknown {Submission not confirmed} queued {Queued} running {Generating} completed {Completed} failed {Failed} cancelled {Cancelled} cancellation_unconfirmed {Cancellation not confirmed} other {Status unknown}}',
  },
  desktopPet: { id: 'toolAction.desktopPet', defaultMessage: 'Create a desktop pet' },
  question: { id: 'toolAction.question', defaultMessage: 'Ask a question' },
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

// Localize the reserved built-in label without changing persisted child identity.
export function formatSubagentLabel(intl: IntlShape, label: string): string {
  return label === 'browser' ? intl.formatMessage(messages.sourceResearch) : label;
}

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
  presentation: 'detail' | 'headline' | 'name' = 'detail',
  fallbackTitle?: string,
  computerTarget?: string,
  response?: ToolResponseMessageContent
): string {
  const name = fullName.split(/__|::/).pop() ?? fullName;
  if (fullName === name && ['schedule_create', 'schedule_pause', 'schedule_resume'].includes(name)) {
    const scheduleActions: Record<string, [string, string, string]> = {
      schedule_create: [
        selectNativeText(intl.locale, 'Create automation task', '创建自动化任务', '建立自動化任務'),
        selectNativeText(intl.locale, 'Creating automation task', '正在创建自动化任务', '正在建立自動化任務'),
        selectNativeText(intl.locale, 'Created automation task', '已创建自动化任务', '已建立自動化任務'),
      ],
      schedule_pause: [
        selectNativeText(intl.locale, 'Pause automation task', '暂停自动化任务', '暫停自動化任務'),
        selectNativeText(intl.locale, 'Pausing automation task', '正在暂停自动化任务', '正在暫停自動化任務'),
        selectNativeText(intl.locale, 'Paused automation task', '已暂停自动化任务', '已暫停自動化任務'),
      ],
      schedule_resume: [
        selectNativeText(intl.locale, 'Resume automation task', '恢复自动化任务', '恢復自動化任務'),
        selectNativeText(intl.locale, 'Resuming automation task', '正在恢复自动化任务', '正在恢復自動化任務'),
        selectNativeText(intl.locale, 'Resumed automation task', '已恢复自动化任务', '已恢復自動化任務'),
      ],
    };
    const action = scheduleActions[name];
    return action[presentation === 'name' ? 0 : state === 'running' ? 1 : state === 'completed' ? 2 : 0];
  }
  if (name === 'generate_image' || name === 'generate_video') {
    const receipt = generatedMediaReceipt(response);
    const displayName =
      fullName === name && args.operation === 'generate'
        ? (mediaDisplayName(receipt?.display_name) ?? mediaDisplayName(args.display_name))
        : undefined;
    const label = displayName
      ? selectNativeText(
          intl.locale,
          `Generate ${displayName}`,
          `生成${displayName}`,
          `生成${displayName}`
        )
      : intl.formatMessage(messages.mediaOperation, {
          kind: name === 'generate_video' ? 'video' : 'image',
          operation: typeof args.operation === 'string' ? args.operation : 'other',
        });
    if (presentation === 'name') return label;
    if (args.__inputPreview === true && state === 'running')
      return intl.formatMessage(messages.generating, { target: `: ${label}` });
    if (!receipt)
      return state === 'running' ? intl.formatMessage(messages.running, { action: label }) : label;
    const statuses =
      typeof receipt.status === 'string'
        ? [intl.formatMessage(messages.mediaJobStatus, { status: receipt.status })]
        : [];
    if (
      args.operation === 'cancel' &&
      receipt.status !== 'cancelled' &&
      receipt.cancellation_confirmed !== true
    )
      statuses.push(
        intl.formatMessage(messages.mediaJobStatus, { status: 'cancellation_unconfirmed' })
      );
    return statuses.length ? `${label}: ${statuses.join(' · ')}` : label;
  }
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
    case 'browser_control':
      action = 'browserAction';
      break;
    case 'subagent_browser':
      action = 'sourceResearch';
      break;
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
    case 'glob':
      action = 'findFiles';
      if (typeof args.pattern === 'string') target = args.pattern;
      break;
    case 'grep':
      action = 'searchContents';
      if (typeof args.pattern === 'string') target = args.pattern;
      break;
    case 'read_image':
      action = 'readImage';
      break;
    case 'search_mcp_tools':
      action = 'discover';
      break;
    case 'list_apps':
      action = 'windows';
      break;
    case 'get_app_state':
      action = 'window';
      break;
    case 'perform_secondary_action':
      action = 'control';
      break;
    case 'set_value':
      action = 'value';
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
    case 'click':
      action = 'mouse';
      break;
    case 'computer_move':
      action = 'move';
      break;
    case 'computer_drag':
    case 'drag':
      action = 'drag';
      break;
    case 'computer_scroll':
    case 'scroll':
      action = 'scroll';
      break;
    case 'computer_key':
    case 'press_key':
      action = 'keyboard';
      break;
    case 'computer_type':
    case 'type_text':
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
    case 'subagent':
      action = 'createAgent';
      break;
    case 'send_message':
      action = 'messageAgent';
      break;
    case 'list_agents':
      action = 'listAgents';
      break;
    case 'skill':
      action = 'skill';
      break;
    case 'working_directory':
      action = 'workingDirectory';
      break;
    case 'load_workspace_dependencies':
      action = 'dependencies';
      break;
    case 'tavily_extract':
    case 'web_scrape':
      action = 'fetch';
      break;
    case 'tavily_crawl':
      action = 'crawl';
      break;
    case 'tavily_map':
      action = 'siteMap';
      break;
    case 'tavily_research':
      action = 'research';
      break;
    case 'time_now':
      action = 'time';
      break;
    case 'location_resolve':
      action = 'location';
      break;
    case 'weather_get':
      action = 'weather';
      break;
    case 'render_mermaid':
      action = 'diagram';
      break;
    case 'render_map':
      action = 'map';
      break;
    case 'render_chord':
    case 'render_donut':
    case 'render_radar':
    case 'render_sankey':
    case 'render_treemap':
    case 'show_chart':
      action = 'chart';
      break;
    case 'generate_image':
      action = 'generateImage';
      break;
    case 'generate_video':
      action = 'generateVideo';
      break;
    case 'create_desktop_pet':
      action = 'desktopPet';
      break;
    case 'ask_user_question':
      action = 'question';
      break;
    case 'take_over':
      action = 'takeover';
      break;
    case 'final_output':
      action = 'result';
      break;
  }
  if (!action) {
    // A supplied display title is presentation only. Raw namespaced identifiers
    // remain in the original request/receipt for routing, approval and diagnostics.
    const title = fallbackTitle?.trim();
    const label =
      title && title !== fullName && title !== name && !/(__|::)/.test(title)
        ? title
        : snakeToTitleCase(name);
    return presentation === 'name' ? label : intl.formatMessage(messages.other, { name: label });
  }
  const fields =
    action === 'browserAction'
      ? { operation: typeof args.operation === 'string' ? args.operation : 'other' }
      : undefined;
  if (presentation === 'name') return intl.formatMessage(messages[action], fields);
  if (computerTarget) target = computerTarget;
  if (!target && action === 'browserAction') {
    const location = args.htmlPath ?? args.path ?? args.url;
    if (typeof location === 'string') {
      try {
        const url = new URL(location);
        target = url.hostname + (url.pathname === '/' ? '' : url.pathname);
      } catch {
        target = location.split(/[\\/]/).filter(Boolean).pop() ?? '';
      }
    }
  }
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
      target: `: ${[intl.formatMessage(messages[action], fields), visibleTarget].filter(Boolean).join(' ')}`,
    });
  }
  if (state === 'completed') {
    if (action === 'read') action = 'readDone';
    else if (action === 'write') action = 'writeDone';
    else if (action === 'edit') action = 'editDone';
    else if (action === 'shell') action = 'shellDone';
    else
      return intl.formatMessage(messages.actionDone, {
        action: [intl.formatMessage(messages[action], fields), visibleTarget]
          .filter(Boolean)
          .join(' '),
      });
  }
  const label = [intl.formatMessage(messages[action], fields), visibleTarget]
    .filter(Boolean)
    .join(' ');
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
