import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { workspaceIdentity } from './workspaces.mjs';
import { permissionPresets } from './permission-presets.mjs';

export const MANAGED_CHAT = Symbol('managed chat creation');
export const MANAGED_APPROVAL = Symbol('target-specific management approval');
const fields = ['id', 'title', 'cwd', 'projectId', 'archivedAt', 'updatedAt', 'globalConversation',
  'readonlyHistory', 'nativeSessionId', 'permissionOverride', 'managementRequestId', 'messageCount'];
const operations = ['create_project', 'start_project', 'rename_project', 'remove_project', 'create_chat',
  'rename_chat', 'archive_chat', 'restore_chat', 'delete_chat', 'set_chat_permission', 'dispatch_chat', 'work_here'];
const string = { type: 'string', minLength: 1, maxLength: 256 };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const projectInfo = project => ({
  projectId: project.name, title: project.properties.title ?? project.name, directories: project.properties.workingDirs ?? [],
});
const chatInfo = (host, row) => ({
  sessionId: row.id, title: row.title, directory: row.cwd, projectId: row.projectId ?? null, archived: Boolean(row.archivedAt),
  running: host.active.has(row.id), updatedAt: row.updatedAt, permissionOverride: row.permissionOverride ?? 'inherit',
});
function required(args, name) {
  if (typeof args[name] !== 'string' || !args[name].trim()) throw Error('Missing ' + name);
  return args[name].trim();
}

function mainCaller(host, main, context) {
  context.signal?.throwIfAborted();
  if (context.sessionId !== main.id || !host.store.readSession(main.id, { fields: ['globalConversation'] })?.globalConversation)
    throw Error('Only the main conversation can use this tool');
}

function receipts(events, offset, limit, excerptLength) {
  const calls = new Map(events.filter(e => e.type === 'tool/call').map(e => [e.data.callId, e.data.name]));
  const results = events.filter(e => e.type === 'tool/result').reverse();
  return { receipts: results.slice(offset, offset + limit).map(event => ({
    sequence: event.seq, callId: event.data.message.toolCallId, tool: calls.get(event.data.message.toolCallId) ?? null,
    error: event.data.message.isError === true, time: event.time,
    excerpt: event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, excerptLength),
  })), nextOffset: results.length > offset + limit ? offset + limit : null };
}

function latestWorkReceipts(events) {
  const calls = new Map();
  const results = [];
  const names = new Set(['write', 'edit', 'pwsh', 'bash', 'read']);
  for (const event of events) {
    if (event.type === 'tool/call' && names.has(event.data.name)) calls.set(event.data.callId, event.data);
    if (event.type !== 'tool/result') continue;
    const call = calls.get(event.data.message.toolCallId);
    if (!call) continue;
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = undefined; }
    }
    const target = args?.file_path ?? args?.description;
    results.push({ tool: call.name, target: typeof target === 'string' ? target.slice(0, 180) : '',
      error: event.data.message.isError === true, time: event.time });
    if (results.length > 3) results.shift();
  }
  return results.reverse();
}

async function currentEvents(host, row) {
  const { events } = await host.driver.history(row.id);
  const latest = host.store.readSession(row.id, { fields: ['nativeSessionId', 'projectId'] });
  if (!latest || row.nativeSessionId !== latest.nativeSessionId || row.projectId !== latest.projectId)
    throw Error('Conversation changed during lookup');
  return events;
}

// Historical notices without a snapshot still identify the exact assignment.
export async function managedTurnBrief(host, main, sessionId, requestId) {
  const notices = host.store.readSession(main.id, { fields: ['globalConversation', 'usageUpdates'] });
  const notice = notices?.globalConversation && notices.usageUpdates?.find(u => {
    const d = u.status?.data;
    return d?.event === 'managed_turn_result' && d.sessionId === sessionId &&
      d.requestId === requestId && d.outcome === 'completed';
  });
  if (!notice) throw Error('Project report does not belong to this conversation');
  if (notice.status.data.brief) return notice.status.data.brief;
  const row = host.store.readSession(sessionId, { fields });
  if (!row || row.readonlyHistory) throw Error('Project history is unavailable');
  return buildTurnBrief(host, row, requestId, notice.status.data.title || row.title);
}

async function buildTurnBrief(host, row, requestId, title) {
  const events = await currentEvents(host, row);
  const start = events.findIndex(e => e.type === 'user/message' && e.data.source?.kind === 'user' && e.data.source.rpcId === requestId);
  if (start < 0) throw Error('The original assignment is unavailable');
  const excerpt = (blocks, limit) => {
    const value = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return value.length > limit ? value.slice(0, limit).trimEnd() + '…' : value;
  };
  const writes = new Set();
  const files = new Set();
  let result = '';
  for (let i = start + 1; i < events.length; i++) {
    const { type, data } = events[i];
    if (type === 'turn/end' || type === 'turn/start' || (type === 'user/message' && data.source?.kind === 'user')) break;
    if (type === 'assistant/message') {
      const blocks = data.message.content;
      result = blocks.some(b => b.type === 'tool-call') ? '' : excerpt(blocks, 600);
    }
    if (type === 'tool/call' && ['write', 'edit'].includes(data.name)) writes.add(data.callId);
    if (type === 'tool/result' && !data.message.isError && writes.has(data.message.toolCallId) && data.meta?.path) {
      const file = data.meta.path;
      files.add(path.isAbsolute(file) ? path.relative(row.cwd, file) || file : file);
    }
  }
  return { title, task: excerpt(events[start].data.content, 240),
    result, files: [...files].slice(0, 5), fileCount: files.size };
}

// Only native write receipts in the resumed request can identify an existing project.
// Resolve the directory before approval so the preview and the child's lease agree.
async function resumedFiles(host, main, sourceId, folder) {
  if (!sourceId) return [];
  const events = await currentEvents(host, main);
  const start = events.findIndex(e => e.type === 'user/message' && e.data.source?.kind === 'user' && e.data.source.rpcId === sourceId);
  if (start < 0) return [];
  const writes = new Set();
  const files = new Set();
  const roots = new Set();
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/end' || event.type === 'turn/start') break;
    if (event.type === 'tool/call' && ['write', 'edit'].includes(event.data.name)) writes.add(event.data.callId);
    if (event.type !== 'tool/result' || event.data.message.isError || !writes.has(event.data.message.toolCallId)) continue;
    const target = event.data.meta?.path;
    if (typeof target !== 'string' || !path.isAbsolute(target)) continue;
    const relative = path.relative(main.cwd, target);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) || parts[0] === '..' || parts.length < 2) continue;
    roots.add(parts[0]);
    if (workspaceIdentity(path.join(main.cwd, parts[0])) === workspaceIdentity(path.join(main.cwd, folder)))
      files.add(parts.slice(1).join('/'));
  }
  if (roots.size && !files.size) throw Error('The resumed work has existing files in: ' + [...roots].join(', ') +
    '. Select the matching original project folder before dispatch.');
  return [...files];
}

async function progress(host, args, rows, projects) {
  let matches = rows.filter(r => !r.globalConversation && (!r.archivedAt || args.sessionId === r.id) &&
    (!args.projectId || args.projectId === r.projectId) && (!args.sessionId || args.sessionId === r.id));
  if (args.query) {
    const key = args.query.trim().toLowerCase();
    const named = new Set(projects.filter(p => [p.projectId, p.title, ...p.directories.flatMap(d => [d, path.basename(d)])]
      .some(value => value.toLowerCase() === key)).map(p => p.projectId));
    matches = matches.filter(r => named.has(r.projectId) || [r.id, r.title, r.cwd, path.basename(r.cwd)]
      .some(value => value?.toLowerCase() === key));
  }
  const candidates = matches.slice(0, 12).map(r => chatInfo(host, r));
  if ((!args.query && !args.projectId && !args.sessionId) || new Set(matches.map(r => r.projectId ?? r.cwd)).size > 1 ||
      matches.length > 4) return { candidates, total: matches.length, needsSelection: true };
  const chats = await Promise.all(matches.map(async row => {
    const events = row.readonlyHistory || (row.messageCount === 0 && !host.active.has(row.id)) ? [] : await currentEvents(host, row);
    const recent = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').slice(-3);
    const lastReply = events.findLast(e => e.type === 'assistant/message' &&
      e.data.message.content.some(b => b.type === 'text' && b.text.trim()));
    const run = host.runs.latest(row.id);
    return { ...chatInfo(host, row), run: run ? { state: run.state, goal: run.goal.slice(0, 700) } : null,
      reportedUpdate: lastReply ? { sequence: lastReply.seq, time: lastReply.time,
        text: lastReply.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, 600) } : null,
      recentRequests: recent.map(e => ({ sequence: e.seq, time: e.time,
        text: e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, 700) })),
      latestWork: latestWorkReceipts(events), ...receipts(events, 0, 3, 650) };
  }));
  return { chats, observedAt: new Date().toISOString() };
}

export async function inspectMainWorkspace(host, main, args) {
  const offset = args.offset ?? 0;
  if (args.operation === 'history' || args.operation === 'receipts') {
    const target = args.operation === 'receipts' ? required(args, 'sessionId') : args.sessionId ?? main.id;
    const row = host.store.readSession(target, { fields });
    if (!row || row.readonlyHistory) throw Error('No native history for this conversation');
    if (args.projectId && args.projectId !== row.projectId) throw Error('Conversation belongs to another project');
    const events = await currentEvents(host, row);
    if (args.operation === 'receipts') {
      return { sessionId: target, directory: row.cwd, ...receipts(events, offset, 8, 1200) };
    }
    const query = (args.query ?? '').toLowerCase();
    const messages = [];
    const currentRequest = target === main.id ? host.active?.get(target)?.replay?.users?.[0]?.messageId : undefined;
    const cleared = host.store.readSession(target, { fields: ['conversationEdits'] })?.conversationEdits?.some(edit => edit.cleared) ?? false;
    const page = { sessionId: target, historyCleared: cleared, messages };
    let matched = 0;
    let hasEarlierMessages = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
      if (currentRequest && event.data.source.rpcId === currentRequest) continue;
      hasEarlierMessages = true;
      const text = event.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const hit = text.toLowerCase().indexOf(query);
      if (hit < 0 || matched++ < offset) continue;
      if (messages.length === 12) return { ...page, nextOffset: offset + 12 };
      const start = Math.max(0, hit - 250);
      messages.push({ sequence: event.seq, messageId: event.data.id, text: text.slice(start, start + 1600) });
    }
    return { ...page, nextOffset: null, ...(!hasEarlierMessages && cleared ? {
      status: 'empty_after_clear', priorUserMessages: 0,
      detail: 'This conversation has zero prior user messages after its history was cleared. There is no earlier statement to retrieve in this chat.',
    } : {}) };
  }
  const rows = host.store.read(['sessions'], { sessionFields: fields }).sessions;
  const projects = (await host.workspaces.listProjects()).map(projectInfo);
  if (args.projectId && !projects.some(p => p.projectId === args.projectId)) throw Error('Unknown project ID');
  if (args.operation === 'progress') return progress(host, args, rows, projects);
  const matches = rows.filter(row => !row.globalConversation && (!args.projectId || row.projectId === args.projectId) &&
    (!args.sessionId || row.id === args.sessionId));
  const chats = matches.slice(offset, offset + 30).map(row => {
    const run = host.runs.latest(row.id);
    return { ...chatInfo(host, row), latestRun: run ? { id: run.runId, state: run.state, goal: run.goal,
      tasks: run.tasks.slice(-10).map(({ name, state }) => ({ name, state })),
      lastEvent: run.recentEvents.at(-1) } : null };
  });
  return { observedAt: new Date().toISOString(), projects: args.projectId ? projects.filter(p => p.projectId === args.projectId) : projects.slice(offset, offset + 30),
    chats, nextOffset: offset + 30 < Math.max(matches.length, args.projectId ? 1 : projects.length) ? offset + 30 : null };
}

async function reportProjectTurn(host, main, row, requestId, terminal) {
  const outcomes = { completed: '已完成', cancelled: '已取消', failed: '失败', interrupted: '已中断' };
  if (!terminal || !Object.hasOwn(outcomes, terminal.status) || terminal.session_id !== row.id ||
      terminal.source_user_message_id !== requestId || !terminal.terminal_message_id) return;
  let brief;
  if (terminal.status === 'completed') {
    try { brief = await buildTurnBrief(host, row, requestId, row.title); }
    catch (error) {
      // Publish the bound receipt even if history is temporarily unavailable.
      console.warn('Project brief could not be read at delivery:', error.message);
    }
  }
  const update = { sessionUpdate: 'status_message', status: { type: 'notice',
    message: terminal.status === 'completed' ? `「${row.title}」的项目简报` : `项目对话「${row.title}」的本轮任务${outcomes[terminal.status]}。`,
    data: { event: 'managed_turn_result', requestId, sessionId: row.id, finishedAt: terminal.finished_at,
      title: row.title, outcome: terminal.status, ...(brief ? { brief } : {}) } } };
  const added = await host.store.updateSession(main.id, saved => {
    if (!saved.globalConversation || (saved.nativeSessionId ?? saved.id) !== (main.nativeSessionId ?? main.id)) return false;
    saved.usageUpdates ??= [];
    if (saved.usageUpdates.some(item => item.status?.data?.event === 'managed_turn_result' &&
        item.status.data.requestId === requestId)) return false;
    saved.usageUpdates.push(update);
    return true;
  });
  if (added) host.scheduleConnection().notify('_goose/unstable/session/update', { sessionId: main.id, update });
}

async function dispatchChat(host, main, row, task, key) {
  const requestId = createHash('sha256').update(JSON.stringify([row.id, key])).digest('hex');
  const receipt = { sessionId: row.id, directory: row.cwd, requestId, status: 'accepted' };
  if (row.messageCount || host.active.has(row.id)) {
    const previous = (await currentEvents(host, row)).find(e =>
      e.type === 'user/message' && e.data.source?.rpcId === requestId);
    if (previous) {
      if (previous.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n') !== task)
        throw Error('Request ID already used for a different assignment');
      return receipt;
    }
  }
  if (host.active.has(row.id)) throw Error('Target is working. Inspect progress before assigning additional work.');
  const connection = host.scheduleConnection();
  const admitted = Promise.withResolvers();
  const notify = connection.notify;
  let terminal;
  connection.notify = (method, params) => {
    const data = params.update?.status?.data;
    if (method === '_goose/unstable/session/update' && params.sessionId === row.id &&
        data?.terminal_message_id && data.source_user_message_id === requestId) terminal = data;
    if (params.sessionId === row.id && params.update?._meta?.['codebuddy/agent-input']?.requestId === requestId)
      admitted.resolve(receipt);
    notify(method, params);
  };
  const finished = host.prompt({ sessionId: row.id, prompt: [{ type: 'text', text: task }],
    _meta: { 'codeagentpro/source-message-id': requestId } }, connection).finally(() => host.disconnect(connection));
  const report = () => reportProjectTurn(host, main, row, requestId, terminal);
  finished.then(report, report).catch(error => console.warn('Project completion notification failed:', error.message));
  // The native input event proves delivery. A completed manager turn does not stop the project turn.
  return Promise.race([admitted.promise, finished.then(() => {
    throw Error('Project turn ended before native input acceptance');
  })]);
}

async function createProjectChat(host, project, cwd, title, key) {
  const existing = host.store.read(['sessions'], { sessionFields: fields }).sessions.find(s => s.managementRequestId === key);
  if (existing) {
    if (existing.projectId !== project.name || existing.cwd !== cwd) throw Error('Request ID belongs to another target');
    return existing;
  }
  // A resource operation owns its lease. The main turn's delivery channel must
  // never subscribe to the target conversation or outlive the main turn.
  const owner = { background: true, notify() {} };
  const lease = await host.workspaces.acquire({ requestedPath: cwd, expectedIdentity: workspaceIdentity(cwd),
    expectedState: (await readdir(cwd)).length ? 'non-empty-directory' : 'empty-directory' }, owner);
  try {
    const result = await host.request('session/new', { cwd, mcpServers: [], [MANAGED_CHAT]: { title, key },
      _meta: { workspaceOrigin: 'selected', workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, projectId: project.name } }, owner);
    return host.store.readSession(result.sessionId, { fields });
  } finally {
    host.connections.delete(owner);
    await host.workspaces.release(lease.leaseId, owner);
  }
}

async function manage(host, main, args, context) {
  const { operation } = args;
  const turn = host.active.get(main.id);
  const connection = turn?.connection;
  const inputCount = turn?.userMessages?.length ?? 0;
  if (!connection?.ask || connection.background) throw Error('Open the main conversation to approve this change');
  const assertWritable = async () => {
    const plan = await host.driver.getPlanMode?.(main.id);
    if (plan?.active || (await host.permissionModes(main)).currentModeId === 'read-only')
      throw Error('The main conversation is in read-only or plan mode');
  };
  await assertWritable();
  if (operation === 'work_here') {
    if (turn.managedHandoff?.inputCount === inputCount) throw Error('The project chat owns this assignment.');
    required(args, 'task');
    turn.localWorkInputCount = inputCount;
    return { changed: false, executionOwner: 'main_chat', directory: main.cwd };
  }
  const projectAction = ['rename_project', 'remove_project', 'create_chat'].includes(operation);
  const createsProject = operation === 'create_project' || operation === 'start_project';
  const chatAction = !projectAction && !createsProject;
  const title = ['create_chat', 'rename_chat', 'rename_project', 'create_project', 'start_project'].includes(operation) ? required(args, 'title') : undefined;
  const folder = createsProject ? required(args, 'folder') : undefined;
  if (folder && (folder !== path.basename(folder) || folder === '.' || folder === '..'))
    throw Error('Choose a direct child of the managed workspace root');
  const files = operation === 'start_project' ? await resumedFiles(host, main, turn.resumedRequestId, folder) : [];
  const root = files.length ? main.cwd : host.managedWorkspaceRoot;
  const project = projectAction ? (await host.workspaces.listProjects()).find(p => p.name === required(args, 'projectId')) : undefined;
  if (projectAction && !project) throw Error('Unknown project ID');
  const row = chatAction ? host.store.readSession(required(args, 'sessionId'), { fields }) : undefined;
  if (chatAction && (!row || row.globalConversation || (args.projectId && row.projectId !== args.projectId)))
    throw Error('Choose a matching ordinary conversation');
  let scopedApproval;
  if (operation === 'set_chat_permission') {
    const sameTitle = host.store.read(['sessions'], { sessionFields: ['id', 'title', 'cwd', 'projectId', 'archivedAt'] }).sessions
      .filter(candidate => candidate.title === row.title && !candidate.archivedAt);
    if (sameTitle.length > 1) {
      if ((!args.projectId && row.projectId) || !args.mode) {
        return { status: 'incomplete_change', changed: false, operation, requiredFields: ['projectId', 'sessionId', 'mode'],
          validModes: ['inherit', ...permissionPresets],
          candidates: sameTitle.map(r => ({ sessionId: r.id, projectId: r.projectId ?? null, directory: r.cwd })),
          message: 'No change was submitted. If the user already identified the project and mode, call manage_workspace again with all three fields. Otherwise ask which project and permission they want. Never apply a guessed mode or apply to both by default.' };
      }
      scopedApproval = { optionId: 'permission:' + row.id + ':' + args.mode, name: row.cwd + ' · ' + row.title + ' → ' + args.mode };
    }
  }
  const cwd = operation === 'create_chat' ? await host.workspaces.resolveProjectDirectory(project.name, args.directory) : undefined;
  if (operation === 'create_chat') required(args, 'requestId');
  const chatTitle = operation === 'start_project' ? (args.chatTitle?.trim() || title) : undefined;
  let task = operation === 'dispatch_chat' || operation === 'start_project' ? required(args, 'task') : undefined;
  if (files.length) task += '\n\n继续当前目录已有实现。先读取相关文件，补齐剩余工作，保留已完成的代码。原请求已写入的文件：\n' + files.join('\n');
  if (task) required(args, 'requestId');
  if (operation === 'dispatch_chat') {
    if (!row.projectId || row.archivedAt || row.readonlyHistory) throw Error('Choose an active project conversation');
    await host.workspaces.resolveProjectDirectory(row.projectId, row.cwd);
  }
  if (operation === 'set_chat_permission' && (!['inherit', ...permissionPresets].includes(args.mode) || row.readonlyHistory))
    throw Error('Choose a writable conversation and a valid preset');
  const preview = { operation, ...(project ? projectInfo(project) : {}), ...(row ? chatInfo(host, row) : {}),
    ...(folder ? { directory: path.join(root, folder) } : {}), ...(cwd ? { directory: cwd } : {}),
    ...(title ? { newTitle: title } : {}), ...(task ? { task, continueLocalWork: args.continueLocalWork === true,
      finishOnAcceptance: !args.continueLocalWork && (args.replyOnAcceptance ?? (operation === 'start_project')) === true } : {}),
    ...(chatTitle ? { chatTitle } : {}), ...(operation === 'set_chat_permission' ? { newMode: args.mode, applies: 'next turn' } : {}) };
  if (operation === 'set_chat_permission') preview.currentMode = (await host.permissionModes(row)).currentModeId;
  const labels = { start_project: '创建项目、创建开发对话并启动任务', create_project: '创建项目文件夹', rename_project: '修改项目名称', remove_project: '移除项目登记（保留磁盘文件）',
    create_chat: '创建对话', rename_chat: '重命名对话', archive_chat: '归档对话', restore_chat: '恢复对话', delete_chat: '删除对话记录',
    set_chat_permission: '调整单个对话的权限', dispatch_chat: '在项目对话中执行任务' };
  const explanation = [labels[operation], preview.title, preview.directory ?? preview.directories?.join(', '),
    preview.projectId, preview.sessionId, title && '新名称 ' + title, chatTitle, task,
    task && !preview.continueLocalWork && '本轮由项目对话执行，主对话负责报告及跟进。',
    preview.finishOnAcceptance && '项目接单后立即返回，结束主对话本轮。项目任务继续运行。',
    preview.newMode && (preview.currentMode + ' → ' + preview.newMode + (preview.running ? '（下一轮生效）' : ''))].filter(Boolean).join('\n');
  if (!(await host.approveTool(main, { name: 'manage_workspace', id: context.callId, arguments: preview, [MANAGED_APPROVAL]: scopedApproval,
    safety: { requiresApproval: true, explanation } }, connection, context.signal)))
    throw Error('Change was not approved');
  mainCaller(host, main, context);
  await assertWritable();
  context.signal?.throwIfAborted();
  if (row) {
    const latest = host.store.readSession(row.id, { fields });
    if (!latest || ['nativeSessionId','cwd','projectId','title','permissionOverride','archivedAt'].some(key => row[key] !== latest[key]))
      throw Error('Target changed during approval; inspect it again');
  }
  if (project) {
    const latest = (await host.workspaces.listProjects()).find(p => p.name === project.name);
    if (!latest || JSON.stringify(latest) !== JSON.stringify(project)) throw Error('Project changed during approval');
  }
  const dispatch = async target => {
    const receipt = await dispatchChat(host, main, target, task, args.requestId);
    if (!preview.continueLocalWork && host.active.get(main.id) === turn)
      turn.managedHandoff = { inputCount, directory: target.cwd };
    const finishOnAcceptance = preview.finishOnAcceptance && host.active.get(main.id) === turn &&
      (turn.userMessages?.length ?? 0) === inputCount;
    if (host.active.get(main.id) === turn) {
      turn.handoffReports ??= new Map();
      turn.handoffReports.set(context.callId, { directory: target.cwd, title: target.title });
    }
    return { ...receipt, executionOwner: 'target_chat', completionVerified: false, finishOnAcceptance };
  };
  if (operation === 'start_project') {
    const started = await host.workspaces.createManagedProject(root, folder, title, 'project-' + randomUUID(), { reuseDirectory: files.length > 0 });
    const directory = await host.workspaces.resolveProjectDirectory(started.name);
    context.signal?.throwIfAborted();
    const chat = await createProjectChat(host, started, directory, chatTitle, args.requestId);
    if (chat.archivedAt || chat.readonlyHistory) throw Error('Cannot dispatch to an archived or imported conversation');
    context.signal?.throwIfAborted();
    const receipt = await dispatch(chat);
    return { ...receipt, projectId: started.name, chatTitle: chat.title };
  }
  if (operation === 'create_project') return projectInfo(await host.workspaces.createManagedProject(root, folder, title, 'project-' + randomUUID()));
  if (operation === 'rename_project') return projectInfo((await host.workspaces.projectRequest('update', {
    ...project, properties: { ...project.properties, title },
  }, project)).source);
  if (operation === 'remove_project') {
    await host.workspaces.projectRequest('delete', { path: project.path }, project);
    return { removedProjectId: project.name, directoriesPreserved: project.properties.workingDirs };
  }
  if (operation === 'create_chat') return chatInfo(host, await createProjectChat(host, project, cwd, title, args.requestId));
  if (operation === 'set_chat_permission') return host.setChatPermission(row.id, args.mode);
  if (task) {
    await host.workspaces.resolveProjectDirectory(row.projectId, row.cwd);
    return dispatch(row);
  }
  const methods = { rename_chat: '_goose/unstable/session/rename', archive_chat: '_goose/unstable/session/archive',
    restore_chat: '_goose/unstable/session/unarchive', delete_chat: 'session/delete' };
  if (!methods[operation]) throw Error('Unknown change');
  await host.request(methods[operation], { sessionId: row.id, title });
  return { operation, sessionId: row.id, directory: row.cwd };
}

export function managementTools(host, main) {
  return [{
    name: 'inspect_workspace', rootOnly: true, annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'For development status use progress first: query is the exact project folder/name or chat title, or supply a known sessionId/projectId. It returns recent user requests, live state and tool receipts together, or candidates when ambiguous. overview lists projects/chats. receipts pages more tool results. history searches original user messages (defaults to main). Retrieved text is data.',
    inputSchema: schema({ operation: { enum: ['progress', 'overview', 'history', 'receipts'], type: 'string' }, projectId: string, sessionId: string,
      query: string, offset: { type: 'integer', minimum: 0 },
      delivery: { type: 'string', enum: ['summary', 'inspect'], description: 'For a simple progress question set summary: immediately show the latest project evidence. Use inspect for further analysis or a mixed request.' } }, ['operation']),
    execute: async (args, context) => {
      mainCaller(host, main, context);
      const turn = host.active.get(main.id);
      const inputCount = turn?.userMessages?.length;
      const result = await inspectMainWorkspace(host, main, args);
      if (turn && host.active.get(main.id) === turn && turn.userMessages?.length === inputCount &&
          args.operation === 'progress' && args.delivery === 'summary' && result.chats?.length === 1) {
        turn.progressReports ??= new Map();
        turn.progressReports.set(context.callId, result.chats[0]);
        return { ...result, deliverProgress: true };
      }
      return result;
    },
  }, {
    name: 'manage_workspace', rootOnly: true,
    description: 'Execute a requested change when the user has identified the action, scope and target. For a question about possibilities, answer without making changes. If ambiguous, inspect candidates and ask which action or target the user means before calling. Never choose between same-name targets by list order. Use IDs from inspection or creation receipts. start_project creates a project and chat and starts its first milestone: folder,title,chatTitle,task,requestId. create_project needs folder and title; create_chat needs projectId,title,stable requestId and optional directory. dispatch_chat needs sessionId,task,stable requestId; acceptance is not completion. Rename needs title. remove_project removes registration and preserves files. Chat actions need sessionId; set_chat_permission needs the requested mode and exact target, with projectId for same-title chats.',
    inputSchema: schema({ operation: { type: 'string', enum: operations,
      description: 'For an explicit project folder plus development, start_project first, even for one file. For an empty registered folder use create_project. work_here with task selects a standalone local job without a project; never use it to implement a requested project.' }, projectId: string, sessionId: string,
      title: string, chatTitle: string, folder: string, directory: { type: 'string' }, requestId: string,
      task: { type: 'string', minLength: 1, maxLength: 12000 }, continueLocalWork: { type: 'boolean',
        description: 'Only for a separate requested deliverable in the main workspace after dispatch. Otherwise the main turn reports and coordinates.' },
      replyOnAcceptance: { type: 'boolean', description: 'A new project develops in its own chat and reports back. For a single project assignment return immediately on acceptance. Set false for additional main-chat deliverables, multiple projects, or an explicit request to wait for verification.' },
      mode: { type: 'string', enum: ['inherit', ...permissionPresets] } }, ['operation']),
    execute: async (args, context) => {
      mainCaller(host, main, context);
      const result = await host.serializeMainChange(() => manage(host, main, args, context));
      if (result.changed === false) return result;
      for (const peer of host.connections) {
        try { peer.notify?.('_codebuddy/workspace/changed', {}); } catch { /* Refresh on reconnect. */ }
      }
      return result;
    },
  }];
}
