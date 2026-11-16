import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const MODEL = 'codepro-e2e';
const READY_REPLY = 'CodePro 本地测试响应：已收到请求。';
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_TRACE_ENTRIES = 128;

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
};

type ChatCompletionRequest = {
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
};

type Completion =
  | { type: 'text'; text: string; reasoning?: string }
  | { type: 'tool'; name: string; arguments: Record<string, unknown> };

export type DeterministicScenario =
  | 'default'
  | 'p0-repair'
  | 'permission-persistence'
  | 'mcp-filesystem'
  | 'skill-management'
  | 'computer-toggle'
  | 'toolbox-capability-toggle'
  | 'autonomy'
  | 'message-identity'
  | 'project-memory';

export type DeterministicRouteStage =
  | 'semantic'
  | 'planner'
  | 'single_file'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'auxiliary';

export type DeterministicRouteTrace = {
  requestSequence: number;
  stage: DeterministicRouteStage;
  markers: {
    semantic: boolean;
    planner: boolean;
    singleFile: boolean;
    coder: boolean;
    tester: boolean;
    reviewer: boolean;
  };
  toolResults: number;
  autonomy?: { goal: string; receiptCount: number; continued: boolean };
};

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function requestText(body: ChatCompletionRequest): string {
  // Goose's OpenAI adapter may send the system prompt either as a system message or as a
  // provider-specific top-level field. Inspect the whole local request so both formats route
  // through the same deterministic behavior.
  return JSON.stringify(body);
}

function toolResultCount(body: ChatCompletionRequest): number {
  return (body.messages ?? []).filter((message) => message.role === 'tool').length;
}

function routeTrace(body: ChatCompletionRequest, requestSequence: number): DeterministicRouteTrace {
  const diagnosticText = requestText(body);
  const markers = {
    semantic: diagnosticText.includes("CodePro's semantic intent router"),
    planner: diagnosticText.includes('CodePro 的主 Agent 和需求分析专家'),
    singleFile: diagnosticText.includes('# CodePro single-file change'),
    coder: diagnosticText.includes('你的角色是编码 Agent'),
    tester: diagnosticText.includes('你的角色是测试 Agent'),
    reviewer: diagnosticText.includes('你是独立审查 Agent'),
  };
  const stage: DeterministicRouteStage = markers.semantic
    ? 'semantic'
    : markers.planner
      ? 'planner'
      : markers.singleFile
        ? 'single_file'
        : markers.coder
          ? 'coder'
          : markers.tester
            ? 'tester'
            : markers.reviewer
              ? 'reviewer'
              : 'auxiliary';
  const autonomy = autonomyContext(body);
  return {
    requestSequence,
    stage,
    markers,
    toolResults: toolResultCount(body),
    ...(autonomy ? { autonomy: autonomy.trace } : {}),
  };
}

function autonomyContext(body: ChatCompletionRequest) {
  const messages = body.messages ?? [];
  const index = messages.findIndex(
    (message) =>
      message.role === 'user' &&
      collectText(message.content).join('\n').includes('AUTONOMY_ACCEPT ')
  );
  if (index < 0) return undefined;
  const directive = collectText(messages[index].content).join('\n');
  const goal = memoryDirectiveValue(directive, 'goal') ?? 'missing-goal';
  const results = messages.slice(index + 1).filter((message) => message.role === 'tool');
  const receipts = new Set(
    results
      .flatMap((message) => collectText(message.content))
      .flatMap((value) =>
        [...value.matchAll(/AUTONOMY_RECEIPT goal=([a-z0-9-]+) index=(\d+)/gu)]
          .filter((match) => match[1] === goal)
          .map((match) => Number(match[2]))
      )
  );
  const continued = messages
    .slice(index + 1)
    .some(
      (message) =>
        message.role === 'user' &&
        collectText(message.content).some((value) => value.trim() === '继续')
    );
  return {
    directive,
    goal,
    results,
    receipts,
    trace: { goal, receiptCount: receipts.size, continued },
  };
}

function autonomyCompletion(body: ChatCompletionRequest): Completion {
  const context = autonomyContext(body);
  if (!context) return { type: 'text', text: 'AUTONOMY_CONTEXT_MISSING 原始任务没有传入。' };
  const { directive, goal, results, receipts } = context;
  const steps = Number(memoryDirectiveValue(directive, 'steps'));
  const handle = Number(memoryDirectiveValue(directive, 'handle'));
  if (
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 60 ||
    !Number.isSafeInteger(handle) ||
    handle < 1
  ) {
    return { type: 'text', text: 'AUTONOMY_DIRECTIVE_INVALID' };
  }
  const tool = (name: string, args: Record<string, unknown>): Completion => {
    const available = findTool(body, name);
    return available
      ? { type: 'tool', name: available, arguments: args }
      : { type: 'text', text: `AUTONOMY_NOT_COMPLETE missing_tool=${name}` };
  };
  if (results.length === 0) return tool('computer_observe', {});
  if (results.length === 1) {
    const observed = collectText(results[0].content).join('\n');
    if (!new RegExp(`"handle"\\s*:\\s*${handle}(?:[,}\\s])`, 'u').test(observed)) {
      return { type: 'text', text: 'AUTONOMY_NOT_COMPLETE owned_window_not_observed' };
    }
    return tool('computer_focus', { handle, expect: { foreground: true, timeout_ms: 5000 } });
  }
  if (!collectText(results[1].content).some((value) => /"outcome"\s*:\s*"worked"/u.test(value))) {
    return { type: 'text', text: 'AUTONOMY_NOT_COMPLETE focus_not_verified' };
  }
  for (let index = 1; index <= steps; index += 1) {
    if (!receipts.has(index))
      return tool('read_document', { path: `autonomy-${String(index).padStart(2, '0')}.txt` });
  }
  return {
    type: 'text',
    text: `AUTONOMY_VERIFIED goal=${goal} receipts=${receipts.size} continued=${context.trace.continued}。已核验本测试窗口聚焦成功和全部 ${steps} 个独立文件的真实读取结果。`,
  };
}

export function recordDeterministicRouteTrace(
  body: ChatCompletionRequest,
  requestSequence: number,
  traces: DeterministicRouteTrace[],
  log: (line: string) => void = console.log
): DeterministicRouteTrace {
  const trace = routeTrace(body, requestSequence);
  traces.push(trace);
  if (traces.length > MAX_TRACE_ENTRIES) traces.shift();
  log(`[codepro-e2e-model] ${JSON.stringify(trace)}`);
  return trace;
}

function availableTool(body: ChatCompletionRequest, shortName: string): string {
  const names = (body.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name));
  return (
    names.find((name) => name === shortName || name.endsWith(`__${shortName}`)) ??
    `developer__${shortName}`
  );
}

function readReviewSnapshot(body: ChatCompletionRequest): {
  files?: Array<{
    path?: string;
    oldText?: string;
    newText?: string;
    hunks?: Array<{
      oldStart?: number;
      oldCount?: number;
      newStart?: number;
      newCount?: number;
    }>;
  }>;
} | null {
  const marker = 'Review this immutable snapshot:\n';
  const prompt = (body.messages ?? [])
    .flatMap((message) => collectText(message.content))
    .find((content) => content.startsWith(marker));
  if (!prompt) return null;
  try {
    return JSON.parse(prompt.slice(marker.length)) as ReturnType<typeof readReviewSnapshot>;
  } catch {
    return null;
  }
}

function reviewCompletion(body: ChatCompletionRequest): Completion {
  const file = readReviewSnapshot(body)?.files?.[0];
  const hunk = file?.hunks?.[0];
  if (!file?.path || !hunk) return { type: 'text', text: JSON.stringify({ findings: [] }) };
  const newSide = Boolean(file.newText) && Number(hunk.newCount) > 0;
  const startLine = Math.max(1, Number(newSide ? hunk.newStart : hunk.oldStart) || 1);
  return {
    type: 'text',
    text: JSON.stringify({
      findings: [
        {
          id: 'codepro-e2e-review-finding',
          priority: 1,
          title: 'Deterministic review finding',
          body: 'Verify this changed line before merging.',
          path: file.path,
          side: newSide ? 'new' : 'old',
          startLine,
          endLine: startLine,
        },
      ],
    }),
  };
}

function findTool(body: ChatCompletionRequest, shortName: string): string | undefined {
  return (body.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name))
    .find((name) => name === shortName || name.endsWith(`__${shortName}`));
}

const TOOLBOX_CAPABILITY_PROBES = [
  ['analyze', 'analyze'],
  ['apps', 'list_apps'],
  ['computer', 'computer_observe'],
  ['code_execution', 'execute_typescript'],
  ['developer', 'shell'],
  ['skills', 'load_skill'],
  ['chatrecall', 'chatrecall'],
  ['extensionmanager', 'manage_extensions'],
  ['git', 'git_status'],
  ['summon', 'delegate'],
  ['summarize', 'summarize'],
  ['todo', 'todo_write'],
  ['computercontroller', 'automation_script'],
  ['autovisualiser', 'render_sankey'],
  ['memory', 'retrieve_memories'],
  ['tutorial', 'load_tutorial'],
] as const;

function toolboxCapabilityMatrix(body: ChatCompletionRequest, text: string): string {
  const values = TOOLBOX_CAPABILITY_PROBES.map(
    ([capability, tool]) => `${capability}=${findTool(body, tool) ? 1 : 0}`
  );
  values.push(`tom=${text.includes('TOOLBOX_TOM_CONTEXT_ACTIVE') ? 1 : 0}`);
  return `TOOLBOX_MATRIX ${values.join(' ')}`;
}

function collectText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [record.text, record.content].flatMap(collectText);
}

function firstToolResultLine(body: ChatCompletionRequest): string | undefined {
  const toolMessage = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'tool');
  return collectText(toolMessage?.content)
    .flatMap((text) => text.split(/\r?\n/u))
    .map((line) => line.trim())
    .find(Boolean);
}

function memoryDirective(
  body: ChatCompletionRequest
): { index: number; value: string } | undefined {
  const messages = body.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const value = collectText(message.content).join('\n');
    if (value.includes('MEMORY_ACCEPT ')) return { index, value };
  }
  return undefined;
}

function toolResultsAfterMemoryDirective(body: ChatCompletionRequest): ChatMessage[] {
  const directive = memoryDirective(body);
  return directive
    ? (body.messages ?? []).slice(directive.index + 1).filter((message) => message.role === 'tool')
    : [];
}

function firstToolResultLineAfterMemoryDirective(body: ChatCompletionRequest): string | undefined {
  return toolResultsAfterMemoryDirective(body)
    .flatMap((message) => collectText(message.content))
    .flatMap((text) => text.split(/\r?\n/u))
    .map((line) => line.trim())
    .find(Boolean);
}

function memoryDirectiveValue(directive: string, key: string): string | undefined {
  return directive.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'u'))?.[1];
}

function parsedMemoryToolResult(line: string | undefined): Record<string, unknown> {
  if (!line) return {};
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function memoryCompletion(
  body: ChatCompletionRequest,
  expectedMarkers: Map<string, string>
): Completion | undefined {
  const directive = memoryDirective(body);
  if (!directive) return undefined;

  const subject = memoryDirectiveValue(directive.value, 'subject');
  const marker = memoryDirectiveValue(directive.value, 'marker');
  const reply = memoryDirectiveValue(directive.value, 'reply') ?? 'missing-reply';
  const assistantResult = (value: string) => `MEMORY_ASSISTANT_RESULT reply=${reply} ${value}`;
  const results = toolResultsAfterMemoryDirective(body).length;

  if (directive.value.includes('MEMORY_ACCEPT remember ')) {
    if (!subject || !marker) return { type: 'text', text: 'MEMORY_DIRECTIVE_INVALID' };
    expectedMarkers.set(subject, marker);
    if (results === 0) {
      const tool = findTool(body, 'project_memory_remember');
      return tool
        ? {
            type: 'tool',
            name: tool,
            arguments: {
              kind: 'project_rule',
              subject,
              content: `Acceptance marker ${marker}`,
              confidence: 'high',
              reason: 'The user explicitly requested this deterministic acceptance memory',
            },
          }
        : { type: 'text', text: 'MEMORY_TOOL_NOT_AVAILABLE' };
    }
    return { type: 'text', text: assistantResult(`MEMORY_REMEMBERED ${marker}`) };
  }

  if (directive.value.includes('MEMORY_ACCEPT search ')) {
    if (results === 0) {
      const tool = findTool(body, 'project_memory_search');
      return tool
        ? {
            type: 'tool',
            name: tool,
            arguments: { query: marker ?? subject ?? '', kinds: [], limit: 20 },
          }
        : { type: 'text', text: 'MEMORY_TOOL_NOT_AVAILABLE' };
    }
    const line = firstToolResultLineAfterMemoryDirective(body);
    const parsed = parsedMemoryToolResult(line);
    return {
      type: 'text',
      text: assistantResult(
        `MEMORY_SEARCH_RESULT matched_count=${String(parsed.matched_count ?? 'unknown')} marker_present=${String(Boolean(marker && line?.includes(marker)))}`
      ),
    };
  }

  if (directive.value.includes('MEMORY_ACCEPT stats')) {
    if (results === 0) {
      const tool = findTool(body, 'project_memory_stats');
      return tool
        ? { type: 'tool', name: tool, arguments: {} }
        : { type: 'text', text: 'MEMORY_TOOL_NOT_AVAILABLE' };
    }
    const parsed = parsedMemoryToolResult(firstToolResultLineAfterMemoryDirective(body));
    return {
      type: 'text',
      text: assistantResult(
        `MEMORY_STATS_RESULT total_entries=${String(parsed.total_entries ?? 'unknown')}`
      ),
    };
  }

  if (directive.value.includes('MEMORY_ACCEPT clear')) {
    if (results === 0) {
      const tool = findTool(body, 'project_memory_clear');
      return tool
        ? { type: 'tool', name: tool, arguments: {} }
        : { type: 'text', text: 'MEMORY_TOOL_NOT_AVAILABLE' };
    }
    return { type: 'text', text: assistantResult('MEMORY_CLEARED') };
  }

  if (directive.value.includes('MEMORY_ACCEPT auto-context ')) {
    if (!subject) return { type: 'text', text: 'MEMORY_DIRECTIVE_INVALID' };
    const expectedMarker = expectedMarkers.get(subject);
    const contextBeforeDirective = JSON.stringify({
      ...body,
      messages: (body.messages ?? []).slice(0, directive.index),
    });
    return {
      type: 'text',
      text: assistantResult(
        expectedMarker && contextBeforeDirective.includes(expectedMarker)
          ? 'MEMORY_AUTO_CONTEXT_PRESENT'
          : 'MEMORY_AUTO_CONTEXT_ABSENT'
      ),
    };
  }

  return { type: 'text', text: 'MEMORY_DIRECTIVE_UNKNOWN' };
}

function plannerPlan(highRisk: boolean, p0Repair: boolean, permissionPersistence: boolean) {
  if (p0Repair) {
    return {
      schema_version: 1,
      goal: '先复现并修复加法测试失败，再由宿主复测同一命令',
      tasks: [
        {
          id: 'diagnostic',
          name: 'node tests.js',
          description: '先运行现有 node tests.js，保存首次失败的宿主结构化证据',
          role: 'tester',
          depends_on: [],
          acceptance_criteria: '宿主运行 node tests.js 并记录真实退出码和输出证据',
          budget: { max_turns: 8 },
          scope: {
            read_scope: ['implementation.js', 'tests.js', 'package.json'],
            write_scope: [],
            behavior_scope: ['复现 add_returns_four 失败并在修复后复测同一命令'],
            forbidden_scope: ['.git/**', '.env', 'credentials/**'],
            required_evidence: ['worker_report', 'command', 'exit_code', 'test_result'],
          },
        },
        {
          id: 'code',
          name: '根据失败证据修复加法实现',
          description: '读取宿主 RepairContext，修复 implementation.js 后交回原 Tester 复测',
          role: 'coder',
          depends_on: ['diagnostic'],
          acceptance_criteria: 'implementation.js 的 add(2, 2) 返回 4，原命令 node tests.js 通过',
          budget: { max_turns: 12 },
          scope: {
            read_scope: ['implementation.js', 'tests.js', 'package.json'],
            write_scope: ['implementation.js'],
            behavior_scope: ['修复 add 的加法语义'],
            forbidden_scope: ['.git/**', '.env', 'credentials/**'],
            required_evidence: ['worker_report', 'changed_files', 'patch'],
          },
        },
      ],
    };
  }
  if (permissionPersistence) {
    return {
      schema_version: 1,
      goal: '执行两个由用户批准的本地写入，并验证任务级授权持续生效',
      tasks: [
        {
          id: 'code-permission',
          name: '执行受保护的本地写入',
          description: '依次写入两个项目文件；第一次请求任务级授权，第二次复用已授予范围',
          role: 'coder',
          depends_on: [],
          acceptance_criteria: '两个写入均真实执行，且第二次执行不重复请求授权',
          budget: { max_turns: 12 },
          scope: {
            read_scope: ['tests/**', 'package.json'],
            write_scope: ['permission-first.txt', 'permission-second.txt'],
            behavior_scope: ['执行用户批准的两个本地写入'],
            forbidden_scope: ['.git/**', '.env', 'credentials/**'],
            required_evidence: ['worker_report', 'changed_files', 'patch'],
          },
        },
        {
          id: 'test-permission',
          name: '验证两个批准动作均已生效',
          description: '运行命令 `node --test`',
          role: 'tester',
          depends_on: ['code-permission'],
          acceptance_criteria: 'node --test 退出码为 0，并确认两个输出文件内容',
          budget: { max_turns: 8 },
          scope: {
            read_scope: [
              'permission-first.txt',
              'permission-second.txt',
              'tests/**',
              'package.json',
            ],
            write_scope: [],
            behavior_scope: ['验证授权动作真实生效'],
            forbidden_scope: ['.git/**', '.env', 'credentials/**'],
            required_evidence: ['worker_report', 'command', 'exit_code', 'test_result'],
          },
        },
      ],
    };
  }
  const coder = highRisk
    ? {
        id: 'code-access',
        name: '实现管理员权限开关',
        description: '只修改 src/access.js 中的本地管理员权限开关，不执行任何远端发布操作',
        role: 'coder',
        depends_on: [],
        acceptance_criteria: 'src/access.js 导出的 adminAccess 为 true，并形成可核验 Patch',
        budget: { max_turns: 12 },
        scope: {
          read_scope: ['src/access.js', 'tests/access.test.mjs', 'package.json'],
          write_scope: ['src/access.js'],
          behavior_scope: ['本地管理员权限开关变为启用'],
          forbidden_scope: ['.git/**', '.env', 'credentials/**', '远端发布'],
          required_evidence: ['worker_report', 'changed_files', 'patch'],
        },
      }
    : {
        id: 'code-route',
        name: '实现问候路由',
        description: '更新问候控制器和路由，并添加对应的 Node 自动化测试',
        role: 'coder',
        depends_on: [],
        acceptance_criteria: '路由返回状态码 200 和 hello，且 tests/route.test.mjs 覆盖该行为',
        budget: { max_turns: 16 },
        scope: {
          read_scope: ['src/**', 'tests/**', 'package.json'],
          write_scope: ['src/**', 'tests/**'],
          behavior_scope: ['问候路由返回状态码 200 和 hello'],
          forbidden_scope: ['.git/**', '.env', 'credentials/**'],
          required_evidence: ['worker_report', 'changed_files', 'patch'],
        },
      };
  const tester = {
    id: highRisk ? 'test-access' : 'test-route',
    name: highRisk ? '独立验证管理员权限开关' : '独立验证问候路由',
    description: '运行命令 `node --test`',
    role: 'tester',
    depends_on: [coder.id],
    acceptance_criteria: 'node --test 实际执行且退出码为 0，测试结果中没有失败用例',
    budget: { max_turns: 8 },
    scope: {
      read_scope: ['src/**', 'tests/**', 'package.json'],
      write_scope: [],
      behavior_scope: ['独立验证用户可观察行为和上游变更'],
      forbidden_scope: ['.git/**', '.env', 'credentials/**'],
      required_evidence: ['worker_report', 'command', 'exit_code', 'test_result'],
    },
  };
  return {
    schema_version: 1,
    goal: highRisk ? '安全地实现权限开关但不发布' : '实现问候路由',
    tasks: [coder, tester],
  };
}

function routeCompletion(
  body: ChatCompletionRequest,
  scenario: DeterministicScenario = 'default',
  expectedMemoryMarkers: Map<string, string> = new Map()
): Completion {
  const text = requestText(body);
  const results = toolResultCount(body);
  const highRisk = text.includes('管理员权限') || text.includes('adminAccess');
  const p0Repair =
    scenario === 'p0-repair' ||
    text.includes('add_returns_four') ||
    text.includes('修复加法') ||
    text.includes('implementation.js');
  const permissionPersistence = scenario === 'permission-persistence';

  if (text.includes('QUESTION_ATTENTION_E2E') && !results) {
    const tool = findTool(body, 'ask_user_question');
    if (tool) return { type: 'tool', name: tool, arguments: {
      questions: [{ id: 'color', question: '验收时选择哪种颜色？' }],
    } };
  }

  if (text.includes('You are a read-only code reviewer')) return reviewCompletion(body);

  // This scenario submits two incidental questions. Keep the real host relation
  // check enabled and answer its schema, rather than bypassing recovery in UI.
  if (
    scenario === 'message-identity' &&
    text.includes('Classify the new user message against the current CodePro run.')
  ) {
    return { type: 'text', text: JSON.stringify({ kind: 'question' }) };
  }

  if (text.includes("CodePro's semantic intent router")) {
    if (scenario === 'autonomy') {
      return {
        type: 'text',
        text: JSON.stringify({
          intent: 'tool_action',
          clarification: null,
          public_summary: '使用电脑控制聚焦本测试窗口并核验指定文件，继续时保留原任务。',
        }),
      };
    }
    const intent =
      (text.includes('回复本地测试确认') ||
        text.includes('电脑控制开关探测') ||
        text.includes('工具箱全部能力开关探测') ||
        text.includes('MEMORY_ACCEPT ')) &&
      !text.includes('创建项目')
        ? 'conversation'
        : 'change';
    return { type: 'text', text: JSON.stringify({ intent, clarification: null }) };
  }

  if (scenario === 'autonomy') return autonomyCompletion(body);

  if (scenario === 'toolbox-capability-toggle' && text.includes('工具箱全部能力开关探测')) {
    return { type: 'text', text: toolboxCapabilityMatrix(body, text) };
  }

  if (scenario === 'project-memory') {
    const completion = memoryCompletion(body, expectedMemoryMarkers);
    if (completion) return completion;
  }

  if (text.includes('CodePro 的主 Agent 和需求分析专家')) {
    return {
      type: 'text',
      text: JSON.stringify(plannerPlan(highRisk, p0Repair, permissionPersistence)),
    };
  }

  if (
    text.includes('CodePro 的结果报告编辑器') ||
    (text.includes('<host_facts>') && text.includes('ReportDraftV1'))
  ) {
    // Deliberately minimal: the host validates evidence references and falls back to its own
    // deterministic renderer when this draft cannot safely represent all immutable facts.
    return {
      type: 'text',
      text: JSON.stringify({
        schema_version: 1,
        summary: '已根据宿主事实生成结果。',
        changes: [],
        verification: [],
        limitations: [],
        next_step: null,
      }),
    };
  }

  if (text.includes('你是独立审查 Agent')) {
    if (permissionPersistence) {
      return {
        type: 'text',
        text: JSON.stringify({
          approved: true,
          summary: '两个任务内写入已形成收据，Tester 通过，授权范围未扩大。',
          issues: [],
          remediation_tasks: [],
        }),
      };
    }
    return {
      type: 'text',
      text: JSON.stringify({
        approved: false,
        summary: '远端发布没有执行，也没有形成可批准的发布证据。',
        issues: ['缺少远端发布前的人工批准；本轮不得宣告完成。'],
        remediation_tasks: [],
      }),
    };
  }

  if (text.includes('你的角色是编码 Agent')) {
    if (p0Repair) {
      if (results === 0) {
        return {
          type: 'tool',
          name: availableTool(body, 'edit'),
          arguments: {
            path: 'implementation.js',
            before: 'return a - b;',
            after: 'return a + b;',
          },
        };
      }
      return {
        type: 'text',
        text: [
          '结论：已根据宿主结构化失败证据修复加法实现。',
          '确认 Bug：',
          '- add 错误地执行减法，导致 add_returns_four 失败。',
          '未验证：',
          '- 无',
          '修改：业务代码 implementation.js。',
          '验证：由原宿主 Tester 重跑 node tests.js。',
          '环境问题：无。',
          'CodePro 未完成：无。',
        ].join('\n'),
      };
    }
    if (permissionPersistence) {
      const steps: Completion[] = [
        {
          type: 'tool',
          name: availableTool(body, 'write'),
          arguments: { path: 'permission-first.txt', content: 'first allowed\n' },
        },
        {
          type: 'tool',
          name: availableTool(body, 'write'),
          arguments: {
            path: 'permission-second.txt',
            content: 'second allowed without another prompt\n',
          },
        },
      ];
      return (
        steps[results] ?? {
          type: 'text',
          text: '两个用户批准的本地写入均已执行；第二个动作复用了同一任务的授权。',
        }
      );
    }
    if (highRisk) {
      if (results === 0) {
        return {
          type: 'tool',
          name: availableTool(body, 'edit'),
          arguments: { path: 'src/access.js', before: 'false', after: 'true' },
        };
      }
      return {
        type: 'text',
        text: [
          '结论：已完成本地权限开关修改；远端发布留给独立审查。',
          '确认 Bug：',
          '- 无',
          '未验证：',
          '- 高 远端发布尚未获批 | src/access.js:1 | 本轮仅完成本地修改',
          '修改：业务代码 src/access.js；测试/报告文件无。',
          '验证：由独立 Tester 执行。',
          '环境问题：无。',
          'CodePro 未完成：等待独立 Reviewer 对发布动作作出裁决。',
        ].join('\n'),
      };
    }

    const coderSteps: Completion[] = [
      {
        type: 'tool',
        name: availableTool(body, 'edit'),
        arguments: {
          path: 'src/controller.js',
          before: "return 'old';",
          after: "return 'hello';",
        },
      },
      {
        type: 'tool',
        name: availableTool(body, 'edit'),
        arguments: {
          path: 'src/route.js',
          before: 'return greeting();',
          after: 'return { status: 200, body: greeting() };',
        },
      },
      {
        type: 'tool',
        name: availableTool(body, 'write'),
        arguments: {
          path: 'tests/route.test.mjs',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { handle } from '../src/route.js';",
            "test('greeting route', () => assert.deepEqual(handle(), { status: 200, body: 'hello' }));",
            '',
          ].join('\n'),
        },
      },
    ];
    return (
      coderSteps[results] ?? {
        type: 'text',
        text: [
          '结论：已实现问候路由、控制器和自动化测试，无需用户处理。',
          '确认 Bug：',
          '- 无',
          '未验证：',
          '- 无',
          '修改：业务代码 src/controller.js、src/route.js；测试 tests/route.test.mjs。',
          '验证：等待独立 Tester 运行 node --test。',
          '环境问题：无。',
          'CodePro 未完成：无。',
        ].join('\n'),
      }
    );
  }

  if (text.includes('你的角色是测试 Agent')) {
    const testCommand = p0Repair ? 'node tests.js' : 'node --test';
    if (results === 0) {
      return {
        type: 'tool',
        name: availableTool(body, 'shell'),
        arguments: { command: testCommand, timeout_secs: 30 },
      };
    }
    return {
      type: 'text',
      text: [
        '结论：独立测试已通过，无需用户处理。',
        '确认 Bug：',
        '- 无',
        '未验证：',
        '- 无',
        '修改：无。',
        `验证：${testCommand}；通过，0 失败，退出码 0。`,
        '环境问题：无。',
        'CodePro 未完成：无。',
      ].join('\n'),
    };
  }

  if (scenario === 'mcp-filesystem' && text.includes('obsidian README.md')) {
    if (results === 0) {
      const tool = findTool(body, 'read_text_file');
      return tool
        ? {
            type: 'tool',
            name: tool,
            arguments: {
              path: String.raw`D:\xwechat_files\wxid_5mloegbbcbl222_d3a5\msg\file\2026-09\obsidian README.md`,
            },
          }
        : { type: 'text', text: 'MCP_NOT_AVAILABLE' };
    }
    return { type: 'text', text: firstToolResultLine(body) ?? 'MCP_RESULT_EMPTY' };
  }

  if (scenario === 'mcp-filesystem' && text.includes('D:\\\\CodeBuddy\\\\Cargo.toml')) {
    if (results === 0) {
      const tool = findTool(body, 'read_text_file');
      return tool
        ? {
            type: 'tool',
            name: tool,
            arguments: { path: String.raw`D:\CodeBuddy\Cargo.toml` },
          }
        : { type: 'text', text: 'MCP_NOT_AVAILABLE' };
    }
    return { type: 'text', text: 'ACCESS_DENIED' };
  }

  if (scenario === 'computer-toggle' && text.includes('电脑控制开关探测')) {
    if (results === 0) {
      const tool = findTool(body, 'computer_observe');
      return tool
        ? { type: 'tool', name: tool, arguments: {} }
        : { type: 'text', text: 'COMPUTER_NOT_AVAILABLE' };
    }
    return { type: 'text', text: 'COMPUTER_TOOL_CALLED' };
  }

  if (scenario === 'skill-management' && text.includes('既定验收规则')) {
    if (results === 0) {
      const tool = findTool(body, 'load_skill');
      return tool
        ? { type: 'tool', name: tool, arguments: { name: 'acceptance-ui-skill' } }
        : { type: 'text', text: 'SKILL_NOT_AVAILABLE' };
    }
    return {
      type: 'text',
      text: text.includes('SKILL_ACCEPTED') ? 'SKILL_USED' : 'SKILL_CONTENT_MISSING',
    };
  }

  if (scenario === 'skill-management' && text.includes('可复用的新技能')) {
    if (results === 0) {
      const tool = findTool(body, 'load_skill');
      return tool
        ? { type: 'tool', name: tool, arguments: { name: 'acceptance-downloaded-skill' } }
        : { type: 'text', text: 'SKILL_NOT_AVAILABLE' };
    }
    return {
      type: 'text',
      text: text.includes('# Loaded Skill: acceptance-downloaded-skill')
        ? 'DOWNLOADED_SKILL_USED'
        : 'SKILL_CONTENT_MISSING',
    };
  }

  if (text.includes('# CodePro read-only analysis') && text.includes('回复本地测试确认')) {
    if (results === 0) {
      return {
        type: 'tool',
        name: availableTool(body, 'read_document'),
        arguments: { path: 'package.json' },
      };
    }
    return {
      type: 'text',
      text: [
        '## 一句话结论',
        READY_REPLY,
        '## 项目用途和结构',
        '已读取当前临时项目的 package.json。',
        '## 关键发现',
        '项目使用 Node 内置测试运行器。',
        '## 风险和建议',
        '未验证：此步骤只用于建立隔离工作区。',
      ].join('\n\n'),
    };
  }

  if (text.includes('# CodePro single-file change')) {
    const steps: Completion[] = [
      {
        type: 'tool',
        name: availableTool(body, 'read_document'),
        arguments: { path: 'src/button.js' },
      },
      {
        type: 'tool',
        name: availableTool(body, 'edit'),
        arguments: { path: 'src/button.js', before: "'old'", after: "'new'" },
      },
      {
        type: 'tool',
        name: availableTool(body, 'shell'),
        arguments: { command: 'node --test tests/button.test.mjs', timeout_secs: 30 },
      },
    ];
    return steps[results] ?? { type: 'text', text: '单文件修改和修改后验证均已执行。' };
  }

  if (text.includes('回复本地测试确认')) {
    return {
      type: 'text',
      text: READY_REPLY,
      reasoning: scenario === 'message-identity' ? '核对请求。\n\n检查回复是否保留。' : undefined,
    };
  }
  return { type: 'text', text: 'CodePro 本地确定性模型已完成请求。' };
}

function writeCompletion(response: ServerResponse, completion: Completion) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const chunk = (choices: unknown[], usage?: unknown) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-codepro-e2e',
      object: 'chat.completion.chunk',
      created: 1_786_118_400,
      model: MODEL,
      choices,
      ...(usage ? { usage } : {}),
    })}\n\n`;

  response.write(
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
  );
  if (completion.type === 'tool') {
    response.write(
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-codepro-${Date.now()}`,
                type: 'function',
                function: {
                  name: completion.name,
                  arguments: JSON.stringify(completion.arguments),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ])
    );
    response.write(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]));
  } else {
    if (completion.reasoning) {
      response.write(
        chunk([{ index: 0, delta: { reasoning_content: completion.reasoning }, finish_reason: null }])
      );
    }
    response.write(chunk([{ index: 0, delta: { content: completion.text }, finish_reason: null }]));
    response.write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
  }
  response.write(chunk([], { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 }));
  response.end('data: [DONE]\n\n');
}

function streamCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  recordTrace: (body: ChatCompletionRequest) => void,
  scenario: DeterministicScenario,
  expectedMemoryMarkers: Map<string, string>
) {
  let requestBytes = 0;
  let rejected = false;
  const chunks: Buffer[] = [];

  request.on('data', (chunk: Buffer) => {
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BYTES && !rejected) {
      rejected = true;
      writeJson(response, 413, { error: { message: 'test request exceeds size limit' } });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });

  request.on('end', () => {
    if (rejected) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatCompletionRequest;
      recordTrace(body);
      const completion = routeCompletion(body, scenario, expectedMemoryMarkers);
      if (body.stream === false && completion.type === 'text') {
        writeJson(response, 200, {
          id: 'chatcmpl-codepro-e2e',
          object: 'chat.completion',
          model: MODEL,
          choices: [
            { index: 0, message: { role: 'assistant', content: completion.text }, finish_reason: 'stop' },
          ],
        });
        return;
      }
      if (
        requestText(body).includes('You are a read-only code reviewer') &&
        requestText(body).includes('cancel-review.ts')
      ) {
        setTimeout(() => {
          if (!response.destroyed) writeCompletion(response, completion);
        }, 3_000);
      } else {
        writeCompletion(response, completion);
      }
    } catch (error) {
      writeJson(response, 400, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
}

export async function startDeterministicOpenAiServer(options?: {
  scenario?: DeterministicScenario;
}): Promise<{
  baseUrl: string;
  requestCount(): number;
  routeTrace(): DeterministicRouteTrace[];
  close(): Promise<void>;
}> {
  const scenario = options?.scenario ?? 'default';
  const traces: DeterministicRouteTrace[] = [];
  const expectedMemoryMarkers = new Map<string, string>();
  let requestSequence = 0;
  let requestCount = 0;
  const recordTrace = (body: ChatCompletionRequest) => {
    requestSequence += 1;
    recordDeterministicRouteTrace(body, requestSequence, traces);
  };
  const server = createServer((request, response) => {
    requestCount++;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      writeJson(response, 200, {
        object: 'list',
        data: [
          {
            id: MODEL,
            object: 'model',
            created: 1_786_118_400,
            owned_by: 'codebuddy-e2e',
            context_window: 128_000,
          },
        ],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      streamCompletion(request, response, recordTrace, scenario, expectedMemoryMarkers);
      return;
    }

    writeJson(response, 404, { error: { message: `unsupported test route: ${url.pathname}` } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('deterministic OpenAI server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requestCount,
    routeTrace: () => traces.map((trace) => ({ ...trace, markers: { ...trace.markers } })),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
