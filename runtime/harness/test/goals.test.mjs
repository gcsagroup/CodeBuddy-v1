import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';

function lastGoal(body) {
  for (const message of body.messages.toReversed()) {
    if (message.role !== 'tool') continue;
    try { const value = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map(x => x.text ?? '').join('')); if (value.goal) return value.goal; } catch {}
  }
  throw Error('Fixture expected a real goal tool receipt');
}
async function fixture(t, handler, { sessionOptions = {}, effectValue } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-goals-'));
  const requests = [], effects = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const tool = (name, args, analysis) => { if (analysis) emit({ content: analysis }); emit({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); emit({}, 'tool_calls'); };
    const text = value => { emit({ content: value }); emit({}, 'stop'); };
    try { await handler({ body, count: requests.length, tool, text }); }
    catch (error) { text(`Fixture error: ${error.message}`); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const input = {
    sessionId: randomUUID(), cwd: root, model: 'fixture',
    provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', contextWindow: 32768, maxTokens: 1024 },
    options: { ...sessionOptions, tools: [{ name: 'fixture_effect', description: 'Write the isolated test marker once', inputSchema: { type: 'object', properties: {} }, async execute() { effects.push('write'); await writeFile(join(root, 'once.txt'), 'preserved checkpoint'); return { count: effects.length, ...(effectValue ? { evidence: effectValue } : {}) }; } }] },
  };
  await driver.createSession(input);
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { root, requests, effects, sessionId: input.sessionId, get driver() { return driver; }, async restart() { await driver.close(); driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root }); await driver.createSession(input); } };
}

test('native plan mode reaches the model, survives restart and exits without changing permissions', { timeout: 20000 }, async t => {
  const f = await fixture(t, async ({ text }) => text('Plan ready for review.'));
  await f.driver.prompt(f.sessionId, 'Plan this change', { planMode: true, onPermission: () => false });
  assert.equal((await f.driver.getPlanMode(f.sessionId)).active, true);
  assert.match(JSON.stringify(f.requests[0].messages), /Plan mode is active/);
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === 'exit_plan_mode'));
  await f.restart();
  assert.equal((await f.driver.getPlanMode(f.sessionId)).active, true);
  await f.driver.setPlanMode(f.sessionId, false);
  assert.equal((await f.driver.getPlanMode(f.sessionId)).active, false);
  await f.driver.prompt(f.sessionId, 'Continue normally', { onPermission: () => false });
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages.filter(m => m.role === 'system')), /Plan mode is active/);
  await assert.rejects(f.driver.setPlanMode(f.sessionId, 'yes'), /boolean/);
});

for (const approved of [false, true]) {
  test(`native plan review leaves planning only after explicit approval: ${approved}`, { timeout: 20000 }, async t => {
    const f = await fixture(t, async ({ count, tool, text }) => {
      if (count === 1) tool('exit_plan_mode', { plan: '# Implementation plan\nInspect the fixture, then verify the result.' });
      else text('Review response received.');
    });
    let reviews = 0;
    await f.driver.prompt(f.sessionId, 'Prepare a plan for review', {
      planMode: true,
      onPermission: () => true,
      onUserQuestions: async ({ questions }) => {
        reviews++;
        assert.equal(questions[0].intent.kind, 'plan-review');
        return { answers: [{ id: questions[0].id, selected: [questions[0].options[approved ? 0 : 1].label] }] };
      },
    });
    assert.equal(reviews, 1);
    assert.equal((await f.driver.getPlanMode(f.sessionId)).active, !approved);
    assert.equal(f.effects.length, 0);
  });
}

test('official goal round driver continues the same session beyond first turn and returns final native goal', { timeout: 15000 }, async t => {
  const f = await fixture(t, async ({ body, count, tool, text }) => {
    if (count === 1) tool('create_goal', { objective: 'Complete the controlled two-round task', max_goal_rounds: 3 });
    else if (count === 2) text('Initial checkpoint; goal still active.');
    else if (count === 3) tool('get_goal', {});
    else if (count === 4) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }); }
    else text('Final goal delivered.');
  });
  const events = [];
  const result = await f.driver.prompt(f.sessionId, 'Create and complete the requested goal', { onPermission: () => true, onEvent: e => events.push(e) });
  assert.equal(result.stopReason, 'end_turn'); assert.equal(result.goal.phase, 'complete'); assert.equal(result.goal.roundsStarted, 1);
  assert.equal(f.requests.length, 5); assert.ok(f.requests[2].messages.some(m => JSON.stringify(m.content).includes('<goal_round>')));
  assert.equal(events.filter(e => e.type === 'harness_event' && e.event.type === 'goal/change').length, 2);
  const history = await f.driver.history(f.sessionId);
  assert.equal(history.events.filter(e => e.type === 'turn/end').length, 2);
  assert.equal(history.events.filter(e => e.type === 'goal/change').at(-1).data.goal.phase, 'complete');
});

test('UI creates the native goal, pauses it, and resumes the same revision through an observed prompt', { timeout: 20000 }, async t => {
  const f = await fixture(t, async ({ body, count, tool, text }) => {
    if (count === 1 || count === 4) tool('get_goal', {});
    else if (count === 2) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'pause' }); }
    else if (count === 5) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }); }
    else text('Checkpoint');
  });
  const first = await f.driver.prompt(f.sessionId, 'Work toward the supplied goal then pause', {
    createGoal: { objective: 'Persist this UI goal', maxGoalRounds: 5 }, onPermission: () => true,
  });
  assert.equal(first.goal.phase, 'paused');
  assert.equal(first.goal.objective, 'Persist this UI goal');
  assert.equal(first.goal.maxGoalRounds, 5);
  await f.restart();
  const saved = await f.driver.getGoal(f.sessionId);
  assert.equal(saved.id, first.goal.id);
  assert.equal(saved.activation, 'disarmed');
  const edited = await f.driver.controlGoal(f.sessionId, { action: 'edit', goalId: saved.id, revision: saved.revision, objective: 'Edited objective with acceptance criteria' });
  assert.equal(edited.id, saved.id);
  assert.equal(edited.objective, 'Edited objective with acceptance criteria');
  assert.equal(edited.phase, 'paused');
  const before = f.requests.length;
  await assert.rejects(f.driver.prompt(f.sessionId, 'stale request', { resumeGoal: { goalId: saved.id, revision: saved.revision - 1 } }), /changed before resume/);
  assert.equal(f.requests.length, before, 'stale controls must not send a model request');
  const approvals = [];
  const final = await f.driver.prompt(f.sessionId, 'Resume the saved goal', { resumeGoal: { goalId: edited.id, revision: edited.revision }, onToolPolicy: () => ({ kind: 'ask' }), onPermission: (tool) => { approvals.push(tool.name); return true; } });
  assert.equal(final.goal.id, saved.id);
  assert.equal(final.goal.phase, 'complete');
  assert.deepEqual(approvals, ['get_goal', 'update_goal']);
  const historyBeforeClear = await f.driver.history(f.sessionId);
  assert.equal(await f.driver.controlGoal(f.sessionId, { action: 'clear', goalId: final.goal.id, revision: final.goal.revision }), null);
  await f.restart();
  assert.equal(await f.driver.getGoal(f.sessionId), undefined);
  const historyAfterClear = await f.driver.history(f.sessionId);
  assert.deepEqual(historyAfterClear.events.slice(0, historyBeforeClear.events.length), historyBeforeClear.events);
});

test('official goal round cap returns blocked with its native reason without extra model rounds', { timeout: 15000 }, async t => {
  const f = await fixture(t, async ({ count, tool, text }) => {
    if (count === 1) tool('create_goal', { objective: 'Controlled unfinished objective', max_goal_rounds: 1 });
    else text('Useful work remains.');
  });
  const result = await f.driver.prompt(f.sessionId, 'Create a one-round goal', { onPermission: () => true });
  assert.equal(result.goal.phase, 'blocked'); assert.equal(result.goal.blockedReason.code, 'round-limit');
  assert.equal(result.goal.roundsStarted, 1); assert.equal(f.requests.length, 3);
});

test('prompt step limit disarms an active native goal before automatic continuation can run again', { timeout: 15000 }, async t => {
  const f = await fixture(t, async ({ count, tool, text }) => {
    if (count === 1) tool('create_goal', { objective: 'Preserve unfinished work at the configured step limit', max_goal_rounds: 10 });
    else text('Work remains after this checkpoint.');
  }, { sessionOptions: { maxTurns: 2 } });
  const result = await f.driver.prompt(f.sessionId, 'Start the goal under this prompt step limit', { onPermission: () => true });
  assert.equal(result.stopReason, 'max_turns'); assert.equal(result.goal.activation, 'disarmed');
  assert.notEqual(result.goal.phase, 'complete'); assert.equal(f.requests.length, 2);
  const before = await f.driver.history(f.sessionId);
  await delay(100);
  const after = await f.driver.history(f.sessionId);
  assert.deepEqual(after.events, before.events); assert.equal(f.requests.length, 2);
});

test('official automatic compaction preserves native goal and todo evidence while long-turn work continues', { timeout: 20000 }, async t => {
  let steps = 0, summaries = 0;
  const todo = { content: 'Preserve module A and verify module B', status: 'in_progress' };
  const f = await fixture(t, async ({ body, tool, text }) => {
    const finalUser = body.messages.findLast(m => m.role === 'user');
    if (JSON.stringify(finalUser?.content).includes('You are now acting as a compaction engine')) {
      summaries += 1; text('Checkpoint: native goal remains active; module A receipt is durable; verify module B.'); return;
    }
    const n = ++steps;
    if (n === 1) tool('create_goal', { objective: 'Retain the native objective across automatic compaction', max_goal_rounds: 3 });
    else if (n === 2) tool('todo_write', { todos: [todo] });
    else if (n === 3) tool('fixture_effect', {}, 'Module A verified; module B requirements remain unchanged. '.repeat(1800));
    else if (n === 4) tool('get_goal', {});
    else if (n === 5) tool('todo_write', { todos: [{ ...todo, status: 'completed' }] });
    else if (n === 6) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }); }
    else text('Compacted task completed.');
  }, { sessionOptions: { autoCompactThreshold: 0.35 }, effectValue: 'Large module diagnostic evidence '.repeat(3500) });
  const result = await f.driver.prompt(f.sessionId, 'Create the goal, plan, execute and verify it', { onPermission: () => true });
  assert.equal(result.goal.phase, 'complete'); assert.ok(summaries > 0); assert.equal(f.effects.length, 1);
  const history = await f.driver.history(f.sessionId);
  const compact = history.events.find(e => e.type === 'compaction/end'); assert.ok(compact);
  const goals = history.events.filter(e => e.type === 'goal/change');
  assert.equal(goals[0].data.goal.id, result.goal.id); assert.equal(goals.at(-1).data.goal.phase, 'complete');
  const todos = history.events.filter(e => e.type === 'todo/write');
  assert.deepEqual(todos[0].data.todos, [todo]); assert.deepEqual(todos.at(-1).data.todos, [{ ...todo, status: 'completed' }]);
  assert.ok(compact.seq > todos[0].seq && compact.seq < todos.at(-1).seq);
  // Native compaction may copy a retained receipt; it must not repeat the side effect.
  const receipts = history.events.filter(e => e.type === 'tool/result' && e.data.message.toolCallId === 'call-3');
  assert.ok(receipts.length >= 1);
  assert.equal(JSON.parse(receipts[0].data.message.content[0].text).count, 1);
  assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'preserved checkpoint');
});

test('structured human resume retains official paused-goal CAS and keeps permissions attached', { timeout: 15000 }, async t => {
  const f = await fixture(t, async ({ body, count, tool, text }) => {
    if (count === 1) tool('create_goal', { objective: 'Pause then resume the controlled objective', max_goal_rounds: 3 });
    else if (count === 2) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'pause' }); }
    else if (count === 3) text('Paused as requested.');
    else if (count === 4) tool('get_goal', {});
    else if (count === 5) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }); }
    else text('Resumed objective complete.');
  });
  const paused = await f.driver.prompt(f.sessionId, 'Create this goal and then pause it until I resume', { onPermission: () => true });
  assert.equal(paused.goal.phase, 'paused'); assert.equal(f.requests.length, 3);
  await assert.rejects(f.driver.controlGoal(f.sessionId, { action: 'resume', goalId: paused.goal.id, revision: paused.goal.revision }), /through prompt/);
  await assert.rejects(f.driver.controlGoal(f.sessionId, { action: 'pause', goalId: paused.goal.id, revision: paused.goal.revision - 1 }), /revision|stale/i);
  assert.equal((await f.driver.getGoal(f.sessionId)).phase, 'paused');
  const approvals = [];
  const resumed = await f.driver.prompt(f.sessionId, 'Resume the paused goal', { resumeGoal: { goalId: paused.goal.id, revision: paused.goal.revision }, onToolPolicy: () => ({ kind: 'ask' }), onPermission(tool) { approvals.push(tool.name); return true; } });
  assert.equal(resumed.goal.phase, 'complete'); assert.equal(resumed.goal.id, paused.goal.id);
  assert.deepEqual(approvals, ['get_goal', 'update_goal']); assert.equal(f.requests.length, 6);
});

test('stopping and restarting disarms native goal until human continuation and does not replay completed side effects', { timeout: 20000 }, async t => {
  let resumed = false;
  const f = await fixture(t, async ({ body, count, tool, text }) => {
    if (!resumed) {
      if (count === 1) tool('create_goal', { objective: 'Preserve first module and complete after restart', max_goal_rounds: 3 });
      else if (count === 2) tool('fixture_effect', {});
      else text('CHECKPOINT');
    } else {
      const lastUser = body.messages.findLastIndex(m => m.role === 'user');
      const tools = body.messages.slice(lastUser + 1).filter(m => m.role === 'tool');
      const automatic = JSON.stringify(body.messages[lastUser]?.content).includes('<goal_round>');
      if (!tools.length) tool('get_goal', {});
      else if (tools.length === 1) { const goal = lastGoal(body); tool('update_goal', { goal_id: goal.id, revision: goal.revision, action: automatic ? 'complete' : 'resume' }); }
      else text(automatic ? 'DONE' : 'Goal rearmed.');
    }
  });
  const controller = new AbortController();
  const cancelled = await f.driver.prompt(f.sessionId, 'Create the goal and save the first module', { signal: controller.signal, onPermission: () => true, onEvent(e) { if (e.type === 'text_delta' && e.text === 'CHECKPOINT') controller.abort(); } });
  assert.equal(cancelled.stopReason, 'cancelled'); assert.equal(cancelled.goal.activation, 'disarmed');
  assert.equal(f.effects.length, 1); const before = await stat(join(f.root, 'once.txt'));
  const historyBefore = await f.driver.history(f.sessionId);
  const requestCount = f.requests.length;
  await f.restart(); await delay(100); assert.equal(f.requests.length, requestCount);
  resumed = true;
  const result = await f.driver.prompt(f.sessionId, 'Continue the same goal from the preserved checkpoint', { onPermission: () => true });
  assert.equal(result.goal.phase, 'complete'); assert.equal(result.goal.id, cancelled.goal.id);
  assert.equal(f.effects.length, 1); assert.equal((await stat(join(f.root, 'once.txt'))).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'preserved checkpoint');
  const history = await f.driver.history(f.sessionId);
  assert.deepEqual(history.events.slice(0, historyBefore.events.length), historyBefore.events);
  assert.equal(history.events.filter(e => e.type === 'tool/result' && e.data.message.toolCallId === 'call-2').length, 1);
});
