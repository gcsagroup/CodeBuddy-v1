import { afterEach, describe, expect, it } from 'vitest';
import { startDeterministicOpenAiServer } from '../tests/e2e/deterministic-openai-server';

type Message = { role: string; content: string; tool_calls?: unknown };

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function complete(
  baseUrl: string,
  messages: Message[],
  tools: string[] = [
    'projectmemory__project_memory_remember',
    'projectmemory__project_memory_search',
    'projectmemory__project_memory_clear',
    'projectmemory__project_memory_stats',
  ]
): Promise<{ text: string; toolName?: string }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'codepro-e2e',
      stream: true,
      messages,
      tools: tools.map((name) => ({ type: 'function', function: { name } })),
    }),
  });
  expect(response.status).toBe(200);
  const events = (await response.text())
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)));
  return {
    text: events.map((event) => event.choices?.[0]?.delta?.content ?? '').join(''),
    toolName: events
      .map((event) => event.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name)
      .find(Boolean),
  };
}

describe('project-memory deterministic provider scenario', () => {
  it('uses the latest directive boundary despite prior tools and a trailing locale user', async () => {
    const server = await startDeterministicOpenAiServer({ scenario: 'project-memory' });
    servers.push(server);
    const priorHistory: Message[] = [
      { role: 'user', content: 'MEMORY_ACCEPT search marker=same-marker reply=old-search' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'old-call' }] },
      { role: 'tool', content: '{"entries":[{"content":"same-marker"}]}' },
      {
        role: 'assistant',
        content: 'MEMORY_ASSISTANT_RESULT reply=old-search MEMORY_SEARCH_RESULT same-marker',
      },
    ];
    const search = await complete(server.baseUrl, [
      ...priorHistory,
      { role: 'user', content: 'MEMORY_ACCEPT search marker=same-marker reply=new-search' },
      { role: 'user', content: '请始终使用简体中文回答。' },
    ]);
    expect(search.toolName).toBe('projectmemory__project_memory_search');

    const completedSearch = await complete(server.baseUrl, [
      ...priorHistory,
      { role: 'user', content: 'MEMORY_ACCEPT search marker=same-marker reply=new-search' },
      { role: 'user', content: '请始终使用简体中文回答。' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'new-call' }] },
      { role: 'tool', content: '{"matched_count":1,"entries":[{"content":"same-marker"}]}' },
    ]);
    expect(completedSearch.text).toContain('MEMORY_ASSISTANT_RESULT reply=new-search');
    expect(completedSearch.text).not.toContain('reply=old-search');

    const clear = await complete(server.baseUrl, [
      ...priorHistory,
      { role: 'user', content: 'MEMORY_ACCEPT clear reply=new-clear' },
      { role: 'user', content: '请始终使用简体中文回答。' },
    ]);
    expect(clear.toolName).toBe('projectmemory__project_memory_clear');
  });

  it('detects auto-injected context without placing the marker in the probe directive', async () => {
    const server = await startDeterministicOpenAiServer({ scenario: 'project-memory' });
    servers.push(server);
    await complete(server.baseUrl, [
      {
        role: 'user',
        content:
          'MEMORY_ACCEPT remember subject=desktop_rule marker=marker-90210 reply=remember-90210',
      },
    ]);

    const present = await complete(server.baseUrl, [
      { role: 'system', content: 'Recalled project memory: Acceptance marker marker-90210' },
      {
        role: 'user',
        content: 'MEMORY_ACCEPT auto-context subject=desktop_rule reply=auto-present',
      },
      { role: 'user', content: '请始终使用简体中文回答。' },
    ]);
    expect(present.text).toBe(
      'MEMORY_ASSISTANT_RESULT reply=auto-present MEMORY_AUTO_CONTEXT_PRESENT'
    );

    const absent = await complete(server.baseUrl, [
      { role: 'system', content: 'No recalled project memory is available.' },
      {
        role: 'user',
        content: 'MEMORY_ACCEPT auto-context subject=desktop_rule reply=auto-absent',
      },
      { role: 'user', content: '请始终使用简体中文回答。' },
    ]);
    expect(absent.text).toBe(
      'MEMORY_ASSISTANT_RESULT reply=auto-absent MEMORY_AUTO_CONTEXT_ABSENT'
    );
  });
});
