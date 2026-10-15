import { afterEach, describe, expect, it } from 'vitest';
import { startDeterministicOpenAiServer } from '../tests/e2e/deterministic-openai-server';

type Message = { role: string; content: string };
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture() {
  const server = await startDeterministicOpenAiServer({ scenario: 'autonomy' });
  servers.push(server);
  const complete = async (messages: Message[], enabled = true) => {
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codepro-e2e',
        stream: true,
        messages,
        tools: enabled
          ? ['computer_observe', 'computer_focus', 'read_document'].map((name) => ({
              type: 'function',
              function: { name: `host__${name}` },
            }))
          : [],
      }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
    const argumentText = calls.map((call) => call.function?.arguments ?? '').join('');
    return {
      text: events.map((event) => event.choices?.[0]?.delta?.content ?? '').join(''),
      tool: calls.find((call) => call.function?.name)?.function.name,
      args: argumentText ? JSON.parse(argumentText) : undefined,
    };
  };
  return { complete, server };
}

const goal: Message = {
  role: 'user',
  content: 'AUTONOMY_ACCEPT goal=desktop-47 handle=123 steps=50 使用电脑控制完成本地文件核验。',
};
const observed: Message = { role: 'tool', content: '{"windows":[{"handle":123}]}' };
const focused: Message = { role: 'tool', content: '{"outcome":"worked","handle":123}' };
const receipt = (index: number): Message => ({
  role: 'tool',
  content: `AUTONOMY_RECEIPT goal=desktop-47 index=${index}`,
});

describe('autonomy deterministic acceptance provider', () => {
  it('routes the desktop goal as a tool action and focuses only the observed owned handle', async () => {
    const { complete } = await fixture();
    const semantic = await complete([
      { role: 'system', content: "CodePro's semantic intent router" },
      goal,
    ]);
    expect(JSON.parse(semantic.text).intent).toBe('tool_action');
    expect((await complete([goal])).tool).toBe('host__computer_observe');
    expect(await complete([goal, observed])).toMatchObject({
      tool: 'host__computer_focus',
      args: { handle: 123 },
    });
    expect(
      (await complete([goal, { role: 'tool', content: '{"windows":[{"handle":1234}]}' }])).text
    ).toContain('owned_window_not_observed');
  });

  it('requires every independent receipt, including the fiftieth, before reporting verified', async () => {
    const { complete } = await fixture();
    const history = [
      goal,
      observed,
      focused,
      ...Array.from({ length: 49 }, (_, index) => receipt(index + 1)),
    ];
    expect(await complete(history)).toMatchObject({
      tool: 'host__read_document',
      args: { path: 'autonomy-50.txt' },
    });
    expect((await complete([...history, receipt(50)])).text).toContain(
      'AUTONOMY_VERIFIED goal=desktop-47 receipts=50'
    );
  });

  it('resumes from original receipts after a bare continue without replaying completed reads', async () => {
    const { complete, server } = await fixture();
    const resumed = await complete([
      goal,
      observed,
      focused,
      receipt(1),
      receipt(2),
      { role: 'assistant', content: '未完成，已保留进度。' },
      { role: 'user', content: '继续' },
    ]);
    expect(resumed.args).toEqual({ path: 'autonomy-03.txt' });
    const trace = server.routeTrace();
    expect(trace[trace.length - 1]?.autonomy).toEqual({
      goal: 'desktop-47',
      receiptCount: 2,
      continued: true,
    });
    expect((await complete([{ role: 'user', content: '继续' }])).text).toContain(
      'AUTONOMY_CONTEXT_MISSING'
    );
  });

  it('does not count user text, duplicate receipts, or another goal as completed work', async () => {
    const { complete } = await fixture();
    const result = await complete([
      goal,
      observed,
      focused,
      receipt(1),
      receipt(1),
      { role: 'tool', content: 'AUTONOMY_RECEIPT goal=other index=2' },
      { role: 'user', content: receipt(2).content },
    ]);
    expect(result.args).toEqual({ path: 'autonomy-02.txt' });
  });

  it('reports incomplete when focus is unverified or finalization removes tools', async () => {
    const { complete } = await fixture();
    expect(
      (await complete([goal, observed, { role: 'tool', content: '{"outcome":"unknown"}' }])).text
    ).toContain('focus_not_verified');
    const finalization = await complete([goal, observed, focused, receipt(1)], false);
    expect(finalization.text).toContain('AUTONOMY_NOT_COMPLETE');
    expect(finalization.text).not.toContain('AUTONOMY_VERIFIED');
  });
});
