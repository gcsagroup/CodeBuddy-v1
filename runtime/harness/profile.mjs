import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SUBAGENT_LIMITS } from '../subagent-limits.mjs';

export const CODEBUDDY_BEHAVIOR = "For requests to build or change a project, use the available file and execution tools to deliver and verify the result. For browser UI deliverables, use browser_control to open and inspect the result when available. If the user asks only for example code or an explanation, answer that request without creating files. Report actions as completed only when their tool receipts confirm them; explain any remaining verification. Finish with actual file or preview links and concise usage instructions. Do not ask the user to copy or save code that you already wrote to their workspace.";

// Explicit Host composition. No TUI/Web client, telemetry, credential discovery,
// or second model/agent loop is installed by this embedding profile.
export function profileEntries(dataDir, cwd, instructionsHome = dataDir) {
  const entry = (id, pkg, config) => ({ id, name: import.meta.resolve(`@deepseek-ai/${pkg}`), ...(config ? { config } : {}) });
  const officeRoot = fileURLToPath(new URL('../office/', import.meta.url));
  const pythonRoot = fileURLToPath(new URL('../py/', import.meta.url));
  // Source checkouts may not have prepared the optional payload yet. Packaged
  // builds require it and verify execution; never borrow a system interpreter.
  const officeReady = existsSync(join(pythonRoot, 'runtime.json'));
  return [
    entry('timer', 'cordis-plugin-timer'),
    entry('typert', 'dsh-typert-registry'),
    entry('llm', 'dsh-llm'),
    entry('llm-pi-ai', 'dsh-llm-pi-ai', { providers: {} }),
    entry('session', 'dsh-session'),
    entry('agent', 'dsh-agent'),
    entry('session-projection', 'dsh-session-projection'),
    entry('goal', 'dsh-goal'),
    entry('goal-round-driver', 'dsh-goal-round-driver'),
    entry('token-meter', 'dsh-token-meter'),
    entry('tool-result-pruner', 'dsh-compaction-tool-result-pruner'),
    entry('working-directory', 'dsh-working-directory'),
    entry('session-persistence-jsonl', 'dsh-session-persistence-jsonl', { root: join(dataDir, 'sessions'), compression: 'none' }),
    entry('session-query', 'dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }),
    entry('storage', 'dsh-storage'),
    entry('storage-json', 'dsh-storage-json', { root: join(dataDir, 'storage') }),
    entry('storage-domain', 'dsh-storage-domain', { backend: 'json' }),
    entry('workspace', 'dsh-workspace'),
    entry('sandbox', 'dsh-sandbox-local'),
    entry('sandbox-policy', 'dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd }),
    entry('filesystem', 'dsh-fs-sandbox', { cwd }),
    entry('attachments', 'dsh-attachment-local', { dshHome: dataDir }),
    entry('commands', 'dsh-commands'),
    entry('file-upload', 'dsh-client-file-upload'),
    entry('system-prompt', 'dsh-system-prompt', {
      includeHarnessIdentity: false,
      personaPrefix: "You are CodeBuddy, an AI software engineering assistant working in the current workspace.",
      includeRuntimeContext: true,
    }),
    entry('tools', 'dsh-tools', { mode: 'native' }),
    entry('user-questions', 'dsh-user-questions'),
    entry('plan-mode', 'dsh-plan-mode', { section: 'Plan mode is active. Inspect and research the task, clarify requirements, and produce a concrete implementation and verification plan. Do not edit project files, run mutating commands, or execute the plan before user review. Present the finished plan with exit_plan_mode; only continue implementation after the user approves. Existing tool permissions and sandbox policy still apply.' }),
    entry('tool-ask-user', 'dsh-tool-ask-user', { mode: 'timed', timeout: 120 }),
    entry('web', 'dsh-web', { fetchProvider: 'http' }),
    entry('web-fetch-http', 'dsh-web-fetch-http', { userAgent: 'CodeBuddy/1.43' }),
    entry('tool-web', 'dsh-tool-web', { search: false, fetch: true }),
    { id: 'agent-instructions', name: new URL('./instructions.mjs', import.meta.url).href, config: { instructionsHome, agentsHome: join(dataDir, 'agents'), maxBytes: 65536 } },
    entry('mcp-resources', 'dsh-mcp-resources'),
    { id: 'skills', name: new URL('./agent-policy.mjs', import.meta.url).href },
    { id: 'skill-computer', name: new URL('./computer-skill.mjs', import.meta.url).href },
    entry('skill-filesystem', 'dsh-skill-filesystem', { dshHome: dataDir, agentsHome: join(dataDir, 'agents'), watch: false }),
    entry('tool-skill', 'dsh-tool-skill'),
    ...(officeReady ? [
      entry('skill-office', 'dsh-skill-office', { assetRoot: officeRoot, node: process.execPath }),
      entry('tool-workspace-dependencies', 'dsh-tool-workspace-dependencies', { source: pythonRoot }),
    ] : []),
    entry('tool-todo', 'dsh-tool-todo', { allowParallelInProgress: true }),
    entry('tool-goal', 'dsh-tool-goal'),
    entry('jobs', 'dsh-jobs-local'),
    entry('tool-jobs', 'dsh-tool-jobs', { completionDelivery: 'quiet' }),
    entry('subagents', 'dsh-subagent', { ...DEFAULT_SUBAGENT_LIMITS }),
    entry('subagent-spawn', 'dsh-subagent-spawn-in-process'),
    entry('subagent-fork', 'dsh-subagent-fork-in-process'),
    entry('tool-subagent', 'dsh-tool-subagent', { provider: 'spawn' }),
    entry('tool-subagent-control', 'dsh-tool-subagent-control'),
    entry('tool-list-agents', 'dsh-tool-subagent-control/list-agents'),
    // Small minified sources must be readable without a shell. Keep DSH's
    // 50 KiB selected-content budget; this cap fits even three-byte UTF-8 text.
    entry('tool-fs', 'dsh-tool-fs', { readMaxLineLength: 16 * 1024 }),
    entry('tool-working-directory', 'dsh-tool-working-directory'),
    entry('tool-fs-search', 'dsh-tool-fs-search', { sampleOverCapGlobResults: false }),
    entry('subprocess', 'dsh-subprocess-local'),
    entry('shell-env', 'dsh-shell-env'),
    entry('shell', process.platform === 'win32' ? 'dsh-pwsh-sandbox' : 'dsh-bash-sandbox'),
    entry('approval', 'dsh-user-approval', { policy: 'ask' }),
    entry('permissions', 'dsh-permission-presets', { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    }, defaultPreset: 'workspace-write' }),
    entry('shell-tools', process.platform === 'win32' ? 'dsh-tool-pwsh' : 'dsh-tool-bash'),
    entry('llm-retry', 'dsh-llm-retry'),
    entry('session-title', 'dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }),
    entry('agent-loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 4 }),
    entry('session-controller', 'dsh-api-session-controller', { nativeOpen: false }),
  ];
}
