import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    entry('working-directory', 'dsh-working-directory'),
    entry('session-persistence-jsonl', 'dsh-session-persistence-jsonl', { root: join(dataDir, 'sessions'), compression: 'none' }),
    entry('session-query', 'dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }),
    entry('storage', 'dsh-storage'),
    entry('storage-json', 'dsh-storage-json', { root: join(dataDir, 'storage') }),
    entry('storage-domain', 'dsh-storage-domain', { backend: 'json' }),
    entry('workspace', 'dsh-workspace'),
    entry('sandbox-policy', 'dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd }),
    entry('filesystem', 'dsh-fs-sandbox', { cwd }),
    entry('attachments', 'dsh-attachment-local', { dshHome: dataDir }),
    entry('commands', 'dsh-commands'),
    entry('file-upload', 'dsh-client-file-upload'),
    entry('system-prompt', 'dsh-system-prompt', {
      includeHarnessIdentity: false,
      personaPrefix: 'You are CodeBuddy, an AI software engineering assistant.',
      includeRuntimeContext: true,
    }),
    entry('tools', 'dsh-tools', { mode: 'native' }),
    entry('web', 'dsh-web', { fetchProvider: 'http' }),
    entry('web-fetch-http', 'dsh-web-fetch-http', { userAgent: 'CodeBuddy/1.43' }),
    entry('tool-web', 'dsh-tool-web', { search: false, fetch: true }),
    { id: 'agent-instructions', name: new URL('./instructions.mjs', import.meta.url).href, config: { instructionsHome, agentsHome: join(dataDir, 'agents'), maxBytes: 65536 } },
    entry('mcp-resources', 'dsh-mcp-resources'),
    entry('skills', 'dsh-skill'),
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
    entry('subagents', 'dsh-subagent', { maxActiveSubagents: 4, maxDepth: 2 }),
    entry('subagent-spawn', 'dsh-subagent-spawn-in-process'),
    entry('subagent-fork', 'dsh-subagent-fork-in-process'),
    entry('tool-subagent', 'dsh-tool-subagent', { provider: 'spawn' }),
    entry('tool-subagent-control', 'dsh-tool-subagent-control'),
    entry('tool-list-agents', 'dsh-tool-subagent-control/list-agents'),
    entry('tool-fs', 'dsh-tool-fs'),
    entry('tool-working-directory', 'dsh-tool-working-directory'),
    entry('tool-fs-search', 'dsh-tool-fs-search', { sampleOverCapGlobResults: false }),
    entry('subprocess', 'dsh-subprocess-local'),
    entry('shell-env', 'dsh-shell-env'),
    entry('shell', process.platform === 'win32' ? 'dsh-pwsh-local' : 'dsh-bash-local'),
    entry('shell-tools', process.platform === 'win32' ? 'dsh-tool-pwsh' : 'dsh-tool-bash'),
    entry('llm-retry', 'dsh-llm-retry'),
    entry('session-title', 'dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }),
    entry('agent-loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 4 }),
    entry('session-controller', 'dsh-api-session-controller', { nativeOpen: false }),
  ];
}
