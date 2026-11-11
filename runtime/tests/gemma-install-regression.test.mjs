import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHarnessDriver } from '../harness/index.mjs';
import { normalizeGemmaResponse, gemmaToolResponseStop } from '../harness/gemma-response.mjs';

const leakedCall = 'call:fixture_effect{prompt:<|"|>将围巾改为蓝色<|"|>}<tool_call|>';

test('Gemma arguments missing advertised required fields enter native recovery before tool execution', async () => {
  const tools=[{name:'write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content']}}];
  for(const args of ['{"content":"file_path: checker.js"}', '{"file_path":"checker.js"}', '{', 'null', '[]']){
    const output=await Array.fromAsync(normalizeGemmaResponse([{type:'block-end',index:0,block:{type:'tool-call',id:'bad',name:'write',arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}],tools));
    assert.equal(output.at(-1).reason.failure.code,'SERVER');
    assert.equal(output.some(c=>c.block?.type==='tool-call'),false);
  }
  const valid={type:'block-end',index:0,block:{type:'tool-call',id:'ok',name:'write',arguments:'{"file_path":"checker.js","content":""}'}};
  assert.deepEqual(await Array.fromAsync(normalizeGemmaResponse([valid],tools)),[valid]);
  assert.deepEqual(await Array.fromAsync(normalizeGemmaResponse([valid],[])),[valid],'unknown schemas remain owned by native tool validation');
});

test('missing file_path can recover or exhaust native retries without looping tool steps or running speculative siblings', {timeout:30000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'cb-gemma-args-'));let requests=0,recover=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(replyToNoActionReview(body,res))return;requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
    if(recover&&requests===2){emit({tool_calls:[{index:0,id:'corrected',type:'function',function:{name:'write',arguments:JSON.stringify({file_path:'result.txt',content:'correct'})}}]});emit({},'tool_calls');}
    else if(recover&&requests===3){emit({content:'Created result.txt.'});emit({},'stop');}
    else{emit({tool_calls:[{index:0,id:'sibling',type:'function',function:{name:'write',arguments:JSON.stringify({file_path:'must-not-exist.txt',content:'not committed'})}},{index:1,id:'bad',type:'function',function:{name:'write',arguments:JSON.stringify({content:'file_path belongs here only as text'})}}]});emit({},'tool_calls');}
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const driver=await createHarnessDriver({cwd:root,dataDir:join(root,'state')});
  t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const s=await driver.createSession({cwd:root,model:'gemma-4-fixture',provider:{id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture',retryPolicy:{mode:'normal',maxRetries:2,backoff:{initialDelayMs:1,maxDelayMs:1,jitterRatio:0}}}});
  await assert.rejects(driver.prompt(s.sessionId,'Create the requested files.',{onPermission:()=>true}),{code:'SERVER'});
  assert.equal(requests,3);
  await assert.rejects(readFile(join(root,'must-not-exist.txt')),{code:'ENOENT'});
  const history=await driver.history(s.sessionId);
  assert.equal(history.events.filter(e=>e.type==='tool/call').length,0);
  assert.equal(history.events.filter(e=>e.type==='llm/retry').length,2);
  recover=true;requests=0;
  const fixed=await driver.createSession({cwd:root,model:'gemma-4-fixture',provider:{id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture',retryPolicy:{mode:'normal',maxRetries:2,backoff:{initialDelayMs:1,maxDelayMs:1,jitterRatio:0}}}});
  assert.equal((await driver.prompt(fixed.sessionId,'Create result.txt.',{onPermission:()=>true})).stopReason,'end_turn');
  assert.equal(await readFile(join(root,'result.txt'),'utf8'),'correct');
  assert.equal(requests,3);
  await assert.rejects(readFile(join(root,'must-not-exist.txt')),{code:'ENOENT'});
});

test('a generated native file receipt invalidates the speculative response without publishing it', async () => {
  const receipt='<path>/workspace/report.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>';
  const call={type:'block-end',index:0,block:{type:'tool-call',id:'real',name:'write',arguments:'{"file_path":"report.md","content":"actual"}'}};
  const later={type:'block-end',index:2,block:{type:'tool-call',id:'speculative',name:'write',arguments:'{"file_path":"other.md","content":"untrusted continuation"}'}};
  for(const prefix of ['', 'ol\n', 'Tool returned:\n']){
    const text=prefix+receipt;
    for(const size of [1,17,text.length]){
      const deltas=Array.from({length:Math.ceil(text.length/size)},(_,i)=>({type:'text-delta',index:1,text:text.slice(i*size,(i+1)*size)}));
      const frames=await Array.fromAsync(normalizeGemmaResponse([call,...deltas,{type:'block-end',index:1,block:{type:'text',text}},later,{type:'finish',reason:{kind:'tool-calls'}}]));
      assert.deepEqual(frames.filter(c=>c.block?.type==='tool-call'),[call]);
      assert.equal(frames.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),'');
      assert.equal(frames.at(-1).reason.failure.code,'SERVER');
    }
  }
  for(const text of ['```xml\n'+receipt+'\n```','Example: `'+receipt+'`','The file contains <path> and <content> XML elements.']){
    const frames=await Array.fromAsync(normalizeGemmaResponse([call,{type:'text-delta',index:1,text},{type:'block-end',index:1,block:{type:'text',text}},{type:'finish',reason:{kind:'tool-calls'}}]));
    assert.equal(frames.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),text);
  }
  const plain=await Array.fromAsync(normalizeGemmaResponse([{type:'text-delta',index:0,text:receipt},{type:'block-end',index:0,block:{type:'text',text:receipt}},{type:'finish',reason:{kind:'stop'}}]));
  assert.equal(plain.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),receipt);
});

test('a server-stripped file-result boundary discards reordered speculative calls before native retry executes a clean write', {timeout:30000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'cb-file-envelope-')), requests=[], visible=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(replyToNoActionReview(body,res))return;
    requests.push(body);res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
    if(requests.length===1){
      emit({tool_calls:[{index:0,id:'actual-write',type:'function',function:{name:'write',arguments:JSON.stringify({file_path:'requested.txt',content:'ACTUAL_CONTENT'})}}]});
      emit({content:'ol\n<path>'+join(root,'requested.txt')+'</path>\n<type>file</type>\n<content>\nCreated file\n</content>'});
      emit({tool_calls:[{index:1,id:'invented-dependent-write',type:'function',function:{name:'write',arguments:JSON.stringify({file_path:'must-not-exist.txt',content:'INVENTED_RESULT'})}}]});
      emit({},'tool_calls');
    }else if(requests.length===2){
      emit({tool_calls:[{index:0,id:'clean-write',type:'function',function:{name:'write',arguments:JSON.stringify({file_path:'requested.txt',content:'ACTUAL_CONTENT'})}}]});
      emit({},'tool_calls');
    }else{emit({content:'已写入 requested.txt。'});emit({},'stop');}
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const driver=await createHarnessDriver({cwd:root,dataDir:join(root,'state')});
  t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const s=await driver.createSession({cwd:root,model:'gemma-4-fixture',provider:{id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture'}});
  const result=await driver.prompt(s.sessionId,'Write ACTUAL_CONTENT to requested.txt.',{onPermission:()=>true,onEvent:e=>{if(e.type==='text_delta')visible.push(e.text)}});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(await readFile(join(root,'requested.txt'),'utf8'),'ACTUAL_CONTENT');
  await assert.rejects(readFile(join(root,'must-not-exist.txt')), {code:'ENOENT'});
  assert.equal(requests.length,3);
  assert.equal(visible.join(''),'已写入 requested.txt。');
  assert(requests[2].messages.some(m=>m.role==='tool'&&JSON.stringify(m.content).includes('Created file')));
  const history=await driver.history(s.sessionId);
  assert.equal(history.events.filter(e=>e.type==='tool/call').length,1);
  assert.equal(history.events.filter(e=>e.type==='llm/retry').length,1);
});

test('installed malformed thought openers never reach visible answers', async () => {
  for (const [reasoning, text] of [['<|cught\n<|c', 'ught\n'], ['', '<|thought\nThinking Process:\nRead the file.']]) {
    for (let split = 0; split <= text.length; split++) {
      const frames = await Array.fromAsync(normalizeGemmaResponse([
        ...[...reasoning].map(text => ({ type: 'reasoning-delta', index: 0, text })),
        ...(reasoning ? [{ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }] : []),
        ...[text.slice(0, split), text.slice(split)].map(text => ({ type: 'text-delta', index: 1, text })),
        { type: 'block-end', index: 1, block: { type: 'text', text } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]));
      assert.equal(frames.at(-1).reason?.failure?.code, 'SERVER');
      assert.equal(frames.filter(c => c.type === 'text-delta').length, 0);
      assert.ok(!frames.filter(c => c.type === 'reasoning-delta').some(c => c.text.includes('<|')));
    }
  }
  for (const text of ['`<|thought` is malformed.', 'Example: <|thought', '<limit']) {
    const frames = await Array.fromAsync(normalizeGemmaResponse([
      ...[...text].map(text => ({ type: 'text-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ]));
    assert.equal(frames.filter(c => c.type === 'text-delta').map(c => c.text).join(''), text);
  }
});

test('Gemma tool-response stop preserves caller stops and leaves other models, protocols and plain answers alone', () => {
  const payload = { tools: [{ type: 'function' }], stop: ['existing'] };
  const model = { api: 'openai-completions', id: 'vendor/gemma-4-26B-A4B-it' };
  assert.deepEqual(gemmaToolResponseStop(payload, model).stop, ['existing', '<|tool_response>']);
  assert.deepEqual(payload.stop, ['existing']);
  assert.deepEqual(gemmaToolResponseStop({ ...payload, stop: '<|tool_response>' }, model).stop, ['<|tool_response>']);
  for (const other of [{ ...model, id: 'different-model' }, { ...model, api: 'anthropic-messages' }])
    assert.equal(gemmaToolResponseStop(payload, other), payload);
  const noTools = { messages: [], tools: [] };
  assert.equal(gemmaToolResponseStop(noTools, model), noTools);
});

test('native Gemma requests hand off before model-authored tool responses and retain multiple independent calls', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-gemma-handoff-'));
  const requests = [], executions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return; requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', model: request.model,
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (requests.length === 1) {
      for (let i = 0; i < 2; i++) emit({ tool_calls: [{ index: i, id: 'call-' + i, type: 'function', function: { name: 'fixture_effect', arguments: JSON.stringify({ index: i }) } }] });
      // Emulate the inference boundary: without it the server continues with
      // an invented tool response instead of returning execution to Harness.
      if (!request.stop?.includes('<|tool_response>')) emit({ content: 'Invented result: completed with fake-job-id.' });
      emit({}, 'tool_calls');
    } else {
      emit({ reasoning_content: '<|c' });
      for (const content of 'ught\n<channel|>已生成。') emit({ content });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const s = await driver.createSession({ cwd: root, model: 'gemma-4-fixture', provider: { id: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, options: { mcpServers: [], tools: [{ name: 'fixture_effect',
      execute: args => { executions.push(args.index); return { status: 'completed', job_id: 'actual-' + args.index }; } }] } });
  const visible = [];
  assert.equal((await driver.prompt(s.sessionId, 'Generate two independent outputs.', { onPermission: () => true,
    onEvent: e => { if (e.type === 'text_delta') visible.push(e.text); } })).stopReason, 'end_turn');
  assert.deepEqual(executions.sort(), [0, 1]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.stop?.includes('<|tool_response>') && !r.stop.includes('<tool_call|>')));
  assert.match(JSON.stringify(requests[1].messages), /actual-0/);
  assert.match(JSON.stringify(requests[1].messages), /actual-1/);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /fake-job-id/);
  assert.equal(visible.join(''), '已生成。');
  const finalMessage = (await driver.history(s.sessionId)).events.findLast(e => e.type === 'assistant/message').data.message;
  assert.deepEqual(finalMessage.content.filter(c => c.type === 'text').map(c => c.text), ['已生成。']);
});

test('leaked Gemma wire calls are rejected across every stream split; examples remain prose', async () => {
  for (const raw of [leakedCall, '<|tool_call>' + leakedCall, '<|channel>thought\n<channel|>' + leakedCall,
    leakedCall + '}\n<|channel>thought\nClaimed submission without a receipt.\n<|tool_call>call:fixture_effect{}']) {
    for (let i = 0; i <= raw.length; i++) {
      const output = await Array.fromAsync(normalizeGemmaResponse([
        ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 0, text })),
        { type: 'block-end', index: 0, block: { type: 'text', text: raw } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]));
      assert.equal(output.at(-1).reason.failure.code, 'SERVER');
      assert.equal(output.filter(c => c.type === 'text-delta').length, 0);
      assert.equal(output.some(c => c.block?.type === 'tool-call'), false);
    }
  }
  for (const text of ['`' + leakedCall + '`', 'Example: ' + leakedCall, 'call: is a protocol prefix.']) {
    const output = await Array.fromAsync(normalizeGemmaResponse([
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ]));
    assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), text);
    assert.equal(output.at(-1).block.text, text);
  }
});

test('native provider retry recovers leaked calls without executing text, and owns exhaustion and cancellation', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-gemma-envelope-'));
  let requests = 0, executions = 0, scenario = 'recover';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return; requests++;
    if (scenario === 'malformed' && requests === 2) {
      assert.equal(request.stream, false);
      assert.equal(request.stream_options, undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'recovered', model: request.model, choices: [{ index: 0,
        finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: 'valid-call', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } },
        ] } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'fixture', model: request.model, choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (scenario === 'malformed' && requests === 1) {
      emit({ tool_calls: [{ index: 0, id: 'must-not-run', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({ tool_calls: [{ index: 1, id: '', type: 'function', function: { name: '', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else if (!['recover', 'malformed'].includes(scenario) || requests === 1) {
      for (const content of leakedCall) emit({ content });
      emit({}, 'stop');
    } else if (requests === 2) {
      emit({ tool_calls: [{ index: 0, id: 'valid-call', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Done.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => {
    await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const session = (delay = 1) => driver.createSession({ cwd: root, model: 'gemma-4-fixture', provider: {
    id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture',
    retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: delay, maxDelayMs: delay, jitterRatio: 0 } },
  }, options: { mcpServers: [], tools: [{ name: 'fixture_effect', execute: () => { executions++; return {}; } }] } });
  const s = await session(); const visible = [];
  assert.equal((await driver.prompt(s.sessionId, 'Use the fixture tool.', { onPermission: async () => true,
    onEvent: e => { if (e.type === 'text_delta') visible.push(e.text); } })).stopReason, 'end_turn');
  assert.equal(requests, 3); assert.equal(executions, 1);
  assert.equal(visible.join(''), 'Done.');
  assert.equal((await driver.history(s.sessionId)).events.filter(e => e.type === 'llm/retry').length, 1);
  scenario = 'exhaust'; requests = 0;
  const exhausted = await session();
  await assert.rejects(driver.prompt(exhausted.sessionId, 'Use the fixture tool.'), { code: 'SERVER' });
  assert.equal(requests, 3); assert.equal(executions, 1);
  scenario = 'cancel'; requests = 0;
  const cancelled = await session(5000); const controller = new AbortController();
  assert.equal((await driver.prompt(cancelled.sessionId, 'Use the fixture tool.', { signal: controller.signal,
    onEvent(e) { if (e.type === 'harness_event' && e.event.type === 'llm/retry') controller.abort(); },
  })).stopReason, 'cancelled');
  assert.equal(requests, 1); assert.equal(executions, 1);
  scenario = 'malformed'; requests = 0;
  const office = await session();
  const result = await driver.prompt(office.sessionId, 'Use the fixture tool.', { onPermission: async () => true });
  assert.equal(result.stopReason, 'end_turn');
  const history = (await driver.history(office.sessionId)).events;
  assert.deepEqual(history.filter(e => e.type === 'tool/call').map(e => e.data.callId), ['valid-call']);
  assert.ok(history.filter(e => e.type === 'approval/asked').every(e => e.data.callId === 'valid-call'));
  assert.equal(executions, 2);
});

test('Gemma text cleanup agrees across streaming and completed blocks for all envelope split positions', async () => {
  for (const [raw, visible] of [
    ['<|channel>thought\n<channel|>', ''],
    ['<|channel>thought\n<channel|>答复', '答复'],
    ['答复<channel|>', '答复'],
    ['引用 `<channel|>` 和 <chan', '引用 `<channel|>` 和 <chan'],
  ]) for (let i = 0; i <= raw.length; i++) {
    const output = await Array.fromAsync(normalizeGemmaResponse([
      ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'text', text: raw } },
    ]));
    assert.equal(output.slice(0, -1).map(c => c.text).join(''), visible);
    assert.equal(output.at(-1).block.text, visible);
  }
});

test('split native Gemma thought boundaries do not leak into short media delivery, while literal examples survive', async () => {
  for (const [reasoning, raw, visible] of [
    ['<|c', 'ught\n<channel|>已生成。', '已生成。'],
    ['<|c', 'ught\n<channel|>', ''],
    ['<|channel>thought\nSave `installed-count', '.txt`.<channel|>', ''],
    ['<|channel>thought\nWrite `résumé', '.md`.\n<channel|>已保存 `résumé.md`。', '已保存 `résumé.md`。'],
    ['<|channel>thought\nUse ``file`name', '.json``.<channel|>OK', 'OK'],
    ['<|channel>thought\nWrite the file', 'nt`.\n<channel|>', ''],
    ['<|channel>thought\nTell the user they need to provide ', 'csv`.<channel|>未找到 `dispatch.csv`。请补充 **`dispatch.csv`**。', '未找到 `dispatch.csv`。请补充 **`dispatch.csv`**。'],
    ['<|channel>thought\nState what needs to be provided: the `disp', 'file.<channel|>没有找到 `dispatch.csv`。请补充 **`dispatch.csv`**。', '没有找到 `dispatch.csv`。请补充 **`dispatch.csv`**。'],
    ['<|channel>thought\nMissing `disp', 'file.<channel|>请补充**`dispatch.csv`**，字面量是 `<channel|>`。', '请补充**`dispatch.csv`**，字面量是 `<channel|>`。'],
    ['<|channel>thought\nInspect.', 'prefix`.<channel|>` and `file.csv`', 'prefix`.<channel|>` and `file.csv`'],
    ['<|channel>thought\nUse `', '`file`name``.<channel|>done', 'done'],
    ['<|channel>thought\nLiteral `<channel|>` then write `fi', 'le`.<channel|>done', 'done'],
    ['<|channel>thought\nDone.<cha', 'nnel|>report.txt', 'report.txt'],
    ['<|channel>thought\nUse ', 'plain .txt and `name.txt`', 'plain .txt and `name.txt`'],
    ['<|channel>thought\nInspect.', 'Show ``sample `<channel|>` here``.', 'Show ``sample `<channel|>` here``.'],
    ['<|channel>thought\nThe file is saved. Say 已', '生成。".<channel|>已生成。', '已生成。'],
    ['<|channel>thought\nInspect the example.', '`<channel|>` is a protocol token.', '`<channel|>` is a protocol token.'],
    ['Ordinary reasoning.', 'Example <channel|> inside text.', 'Example <channel|> inside text.'],
    ['<|channel>thought\nFinished.<channel|>', 'Literal <channel|> inside text.', 'Literal <channel|> inside text.'],
    ['<|c', '已生成。', '已生成。'],
  ]) for (let i = 0; i <= raw.length; i++) {
    const output = await Array.fromAsync(normalizeGemmaResponse([
      ...[...reasoning].map(text => ({ type: 'reasoning-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 1, text })),
      { type: 'block-end', index: 1, block: { type: 'text', text: raw } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]));
    assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), visible);
    assert.equal(output.find(c => c.type === 'block-end' && c.block.type === 'text').block.text, visible);
    assert.equal(output.at(-1).reason.kind, 'stop');
  }
});

test('a quoted boundary at the native split remains hidden across a long answer', async () => {
  const reasoning = '<|channel>thought\nMissing `disp';
  const answer = '说明。'.repeat(600) + '请补充 `dispatch.csv`。';
  const prefix = 'file.<channel|>';
  const output = await Array.fromAsync(normalizeGemmaResponse([
    { type: 'reasoning-delta', index: 0, text: reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
    ...[prefix, answer.slice(0, 1200), answer.slice(1200)].map(text => ({ type: 'text-delta', index: 1, text })),
    { type: 'block-end', index: 1, block: { type: 'text', text: prefix + answer } },
  ]));
  assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), answer);
  assert.equal(output.at(-1).block.text, answer);
});

test('runaway reasoning is bounded without changing intentionally repeated final prose', async () => {
  const text = 'This is the same sufficiently long paragraph.\n\n'.repeat(30);
  const answer = { type: 'text-delta', index: 0, text };
  assert.deepEqual(await Array.fromAsync(normalizeGemmaResponse([answer])), [answer]);
  const output = await Array.fromAsync(normalizeGemmaResponse([{ ...answer, type: 'reasoning-delta' }]));
  assert.equal(output.at(-1).reason.failure.code, 'SERVER');
});

test('short-line degeneration is rejected independently of stream chunk boundaries', async () => {
  const text = "Actually, let's go.\n".repeat(90);
  for (const size of [1, 7, 31, text.length]) {
    const deltas = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => ({
      type: 'reasoning-delta', index: 0, text: text.slice(i * size, (i + 1) * size),
    }));
    const output = await Array.fromAsync(normalizeGemmaResponse(deltas));
    assert.equal(output.at(-1).reason?.failure?.code, 'SERVER');
    const answer = deltas.map(c => ({ ...c, type: 'text-delta' }));
    assert.equal((await Array.fromAsync(normalizeGemmaResponse(answer))).map(c => c.text).join(''), text);
  }
});

test('installed Gemma single-line repetition is bounded while repeated final text and file arguments remain intact', async () => {
  const text = ' l,'.repeat(500);
  for (const size of [1, 7, 63, text.length]) {
    const deltas = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => ({
      type: 'text-delta', index: 1, text: text.slice(i * size, (i + 1) * size),
    }));
    const output = await Array.fromAsync(normalizeGemmaResponse([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      ...deltas,
    ]));
    assert.equal(output.at(-1).reason?.failure?.code, 'SERVER');
    assert.equal(output.filter(c => c.type === 'text-delta').length, 0);
    assert.equal((await Array.fromAsync(normalizeGemmaResponse(deltas))).map(c => c.text).join(''), text);
  }
  const argumentsDelta = { type: 'tool-call-delta', index: 0, id: 'real-file', name: 'write', arguments: JSON.stringify({ content: text }) };
  assert.deepEqual(await Array.fromAsync(normalizeGemmaResponse([argumentsDelta])), [argumentsDelta]);
});

test('pending native tool calls cannot publish fabricated receipts or unparsed thought boundaries', async () => {
  const text = '<tool>\n<path>v2/summary.csv</path>\n<content>old values</content>\n</tool>\nRechecking.<channel|><tool>invented receipt</tool>';
  const completedOnly = await Array.fromAsync(normalizeGemmaResponse([
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
  ]));
  assert.equal(completedOnly.at(-1).reason.failure.code, 'SERVER');
  assert.equal(completedOnly.some(c => c.type === 'block-end'), false);
  for (let i = 0; i <= text.length; i++) {
    const frames = await Array.fromAsync(normalizeGemmaResponse([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'incomplete', name: 'read', arguments: '{' },
      ...[text.slice(0, i), text.slice(i)].map(text => ({ type: 'text-delta', index: 1, text })),
    ]));
    assert.equal(frames.at(-1).reason?.failure?.code, 'SERVER');
    assert.equal(frames.filter(c => c.type === 'text-delta').length, 0);
  }
  for (const text of ['A legitimate explanation.', 'Literal `<channel|>` in documentation.', '```xml\n<channel|>\n```']) {
    const frames = await Array.fromAsync(normalizeGemmaResponse([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      ...[...text].map(text => ({ type: 'text-delta', index: 1, text })),
      { type: 'block-end', index: 1, block: { type: 'text', text } },
    ]));
    assert.equal(frames.filter(c => c.type === 'text-delta').map(c => c.text).join(''), text);
    assert.equal(frames.at(-1).block.text, text);
  }
});

test('a thought opener after ordinary prose is rejected without displaying its split marker', async () => {
  const text = 'First we will create the files.\n\n<|channel>thought';
  for (let cut = 0; cut <= text.length; cut++) {
    const frames = await Array.fromAsync(normalizeGemmaResponse([
      ...[text.slice(0, cut), text.slice(cut)].map(text => ({ type: 'text-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ]));
    assert.equal(frames.at(-1).reason?.failure?.code, 'SERVER');
    assert.ok(!frames.filter(frame => frame.type === 'text-delta').map(frame => frame.text).join('').includes('<|channel>'));
  }
  const quoted = 'The marker is `<|channel>thought` in this example.';
  const frames = await Array.fromAsync(normalizeGemmaResponse([
    ...[...quoted].map(text => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: quoted } },
  ]));
  assert.equal(frames.filter(frame => frame.type === 'text-delta').map(frame => frame.text).join(''), quoted);
});

test('a second unquoted thought boundary is rejected even when the server lost the native tool call', async () => {
  const raw = 'ile.<channel|><tool>\n<path>v2/summary.csv</path>\n</tool>\nRechecking.<channel|><tool>invented receipt</tool>';
  for (let i = 0; i <= raw.length; i++) {
    const frames = await Array.fromAsync(normalizeGemmaResponse([
      { type: 'reasoning-delta', index: 0, text: '<|channel>thought\nI need to read the new f' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '<|channel>thought\nI need to read the new f' } },
      ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 1, text })),
    ]));
    assert.equal(frames.at(-1).reason?.failure?.code, 'SERVER');
    assert.ok(!frames.filter(c => c.type === 'text-delta').map(c => c.text).join('').includes('<channel|>'));
  }
});

for (const [caseName, text] of [
  ['installed malformed thought opener', '<|thought\nThinking Process:\nRead the file.'],
  ['unparsed boundary', '<tool>invented file receipt</tool><channel|><tool>' + 'untrusted trailing output '.repeat(500)],
  ['installed single-line repetition', ' l,'.repeat(3000)],
]) test(`rejecting ${caseName} closes its HTTP stream and recovers exactly once without a reminder`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-gemma-stream-recovery-'));
  let requests = 0, executions = 0, sent = 0, closedEarly = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (replyToNoActionReview(JSON.parse(body), res)) return;
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'fixture', model: 'gemma-4-fixture', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (requests === 1) {
      emit({ tool_calls: [{ index: 0, id: 'discarded', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      const timer = setInterval(() => {
        emit({ content: text.slice(sent, sent + 8) }); sent += 8;
        if (sent >= text.length) { clearInterval(timer); emit({}, 'tool_calls'); res.end('data: [DONE]\n\n'); }
      }, 5);
      res.on('close', () => { closedEarly = sent < text.length; clearInterval(timer); });
    } else if (requests === 2) {
      emit({ tool_calls: [{ index: 0, id: 'valid', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    } else { emit({ content: 'Verified.' }); emit({}, 'stop'); res.end('data: [DONE]\n\n'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const s = await driver.createSession({ cwd: root, model: 'gemma-4-fixture', provider: {
    id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture',
    retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  }, options: { mcpServers: [], tools: [{ name: 'fixture_effect', execute: () => { executions++; return {}; } }] } });
  const visible = [];
  const result = await driver.prompt(s.sessionId, 'Use the fixture tool.', { onPermission: () => true,
    onEvent: e => { if (e.type === 'text_delta') visible.push(e.text); } });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(closedEarly, true);
  assert.equal(requests, 3);
  assert.equal(executions, 1);
  assert.equal(visible.join(''), 'Verified.');
  const events = (await driver.history(s.sessionId)).events;
  assert.deepEqual(events.filter(e => e.type === 'tool/call').map(e => e.data.callId), ['valid']);
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
});

test('native thought markers stay out of every displayed reasoning frame', async () => {
  for (const [raw, expected] of [['<|c', ''], ['<|channel>thought', ''],
    ['<|channel>thought\nWrite report.txt<channel|>', '\nWrite report.txt'],
    ['Example `<|channel>thought` in .txt', 'Example `<|channel>thought` in .txt'],
    ['<limit and report.txt', '<limit and report.txt']]) {
    const frames = await Array.fromAsync(normalizeGemmaResponse([
      ...[...raw].map(text => ({ type: 'reasoning-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } },
    ]));
    assert.equal(frames.filter(f => f.type === 'reasoning-delta').map(f => f.text).join(''), expected);
    assert.equal(frames.at(-1).block.text, expected);
  }
});

test('a managed task inside a checkout uses its own instructions and skill roots; a degenerate tool response cannot execute', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-install-repro-'));
  const container = join(root, 'storage', 'workspaces'), cwd = join(container, 'task');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'AGENTS.md'), 'HOST_CHECKOUT_ONLY');
  await writeFile(join(cwd, 'AGENTS.md'), 'TASK_LOCAL_ONLY');
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'fixture', model: 'gemma-4-fixture', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (requests.length === 1) {
      emit({ tool_calls: [{ index: 0, id: 'must-not-run', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      for (let i = 0; i < 134; i++) emit({ content: "Let's go.\nActually, the `ScraplingServer` will also implement `Default`.\n\n" });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Ready to continue.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd, managedWorkspaceRoot: container });
  t.after(async () => {
    await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  let executions = 0;
  const session = await driver.createSession({ cwd, model: 'gemma-4-fixture', provider: { id: 'fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture' }, options: {
    mcpServers: [], tools: [{ name: 'fixture_effect', execute: () => { executions++; return {}; } }],
  } });
  const visible = [];
  assert.equal((await driver.prompt(session.sessionId, 'Connect the tool.', { onPermission: async () => true,
    onEvent: event => { if (event.type === 'text_delta') visible.push(event.text); } })).stopReason, 'end_turn');
  assert.equal(executions, 0);
  assert.equal(visible.join(''), 'Ready to continue.');
  assert.equal(requests.length, 2);
  assert.equal((await driver.history(session.sessionId)).events.filter(e => e.type === 'llm/retry').length, 1);
  assert.match(JSON.stringify(requests[0].messages), /TASK_LOCAL_ONLY/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /HOST_CHECKOUT_ONLY/);
  const catalog = await driver.skillCatalog(cwd);
  assert.equal(catalog.roots.find(r => r.source === 'project-agents').path, join(cwd, '.agents', 'skills'));
  assert.equal((await driver.prompt(session.sessionId, 'Continue.')).stopReason, 'end_turn');
});

test('alternating installed receipt paragraphs are rejected before publishing; file data and final prose stay intact', async () => {
  const cycle='</path>\n<type>bash</type>\n<content>\nUpdated file\n</content>\n\n(Done.)\n\n</path>\n<type>bash</type>\n<content>\nUpdated file\n</content>\n\n(Final answer.)\n\n';
  const text=cycle.repeat(30);
  for(const size of [1,37,text.length]) {
    const deltas=Array.from({length:Math.ceil(text.length/size)},(_,i)=>({type:'text-delta',index:1,text:text.slice(i*size,(i+1)*size)}));
    const frames=await Array.fromAsync(normalizeGemmaResponse([{type:'block-start',index:0,blockType:'tool-call'},...deltas]));
    assert.equal(frames.at(-1).reason?.failure?.code,'SERVER');
    assert.equal(frames.some(c=>c.type==='text-delta'),false);
    assert.equal((await Array.fromAsync(normalizeGemmaResponse(deltas))).map(c=>c.text).join(''),text);
  }
  const delta={type:'tool-call-delta',index:0,id:'file',name:'write',arguments:JSON.stringify({content:text})};
  assert.deepEqual(await Array.fromAsync(normalizeGemmaResponse([delta])),[delta]);
  const varied=Array.from({length:100},(_,i)=>`Receipt ${i}: completed distinct work.\n\n`).join('');
  const frames=await Array.fromAsync(normalizeGemmaResponse([{type:'reasoning-delta',index:0,text:varied}]));
  assert.equal(frames.some(c=>c.reason?.failure),false);
});
