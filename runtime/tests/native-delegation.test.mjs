import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { listSubagentCatalog, readSubagentConversation } from '../subagent-conversations.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';

test('native child stays unattended through six live switches and cold cross-turn reuse', { timeout: 45000 }, async t => {
  const root=await mkdtemp(join(tmpdir(),'codebuddy-delegation-'));
  const project=join(root,'project'); await mkdir(project);
  const nativeId=randomUUID(),productId=randomUUID();
  let childId, gate, ready, blockRead=false;
  const model=createServer(async (req,res)=>{
    let raw=''; for await(const part of req) raw+=part;
    const body=JSON.parse(raw);
    const child=body.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('Your parent agent id is'));
    const marker=child?'NI_CHILD_':'NI_PARENT_';
    const user=body.messages.findLastIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes(marker));
    const id=JSON.stringify(body.messages[user].content).match(new RegExp(marker+'([A-Z0-9]+)'))[1];
    const done=body.messages.slice(user+1).filter(m=>m.role==='tool');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason)=>res.write(`data: ${JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    let name,args;
    if(!child&&done.length===0) {
      name=childId?'send_message':'subagent';
      args=childId?{agent_id:childId,message:`NI_CHILD_${id}`}:{description:'Reusable permission worker',prompt:`NI_CHILD_${id}`};
    } else if(child&&done.length===0) {
      name='working_directory'; args={};
    } else if(child&&done.length===1) {
      name='write';args={file_path:join(project,`${id}.txt`),content:id};
    } else if(child&&done.length===2) {
      name=process.platform==='win32'?'pwsh':'bash';
      args={command:process.platform==='win32'?`Write-Output 'NI_COMMAND_${id}'`:`printf 'NI_COMMAND_${id}'`,description:'Print isolated test marker'};
    } else if(child&&done.length===3) {
      name='send_message';args={agent_id:nativeId,message:`NI_RESULT_${id}: ${JSON.stringify(done.slice(1).map(m=>m.content))}`};
    }
    if(name) {
      emit({role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},null);
      emit({},'tool_calls');
    } else {emit({role:'assistant',content:child?`NI_RESULT_${id}: child completed its permitted work.`:`NI_PARENT_DONE_${id}`},null);emit({},'stop');}
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  let driver=await createHarnessDriver({dataDir:join(root,'native'),cwd:project});
  t.after(async()=>{await driver.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));});
  const provider={id:'fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only',protocol:'openai-completions'};
  await driver.createSession({sessionId:nativeId,cwd:project,provider,model:'fixture-model'});
  const store=await openStore(join(root,'host'));
  const session={id:productId,nativeSessionId:nativeId,cwd:project,mode:'smart_approve',type:'code_pro',workspaceBinding:'writable_project',updates:[]};
  await store.update(state=>state.sessions.push(session));
  const host={store,settings:{extensions:async()=>[]},active:new Map(),safety:new SafetyPolicy(store)};
  const calls=[],events=[];
  const connection={async ask(){assert.fail('A delegated tool must never open a human approval RPC');}};
  const callbacks={onEvent:event=>events.push(event),onPermission:async call=>{
    calls.push(call);
    const accepted=await Compat.prototype.approveTool.call(host,session,call,connection,call.signal);
    if(blockRead&&call.delegated&&call.name==='working_directory') {ready.resolve();await gate.promise;}
    return accepted;
  }};
  await driver.prompt(nativeId,'NI_PARENT_INITIAL',callbacks);
  childId=(await driver.listSubagentChildren(nativeId))[0].id;
  assert.equal((await driver.listSubagentChildren(nativeId)).length,1);
  const mode=async value=>store.update(state=>{state.sessions.find(s=>s.id===productId).mode=value;});
  const matrix=[['approve','smart_approve'],['smart_approve','approve'],['approve','auto'],['auto','smart_approve'],['smart_approve','auto'],['auto','approve']];
  for(const [i,[from,to]] of matrix.entries()) {
    const id=`CASE${i}`,offset=events.length;
    ready=Promise.withResolvers();gate=Promise.withResolvers();blockRead=true;
    await mode(from);
    const running=driver.prompt(nativeId,`NI_PARENT_${id}`,callbacks);
    await ready.promise;
    await mode(to);gate.resolve();
    await running;blockRead=false;
    assert.deepEqual((await driver.listSubagentChildren(nativeId)).map(c=>c.id),[childId]);
    const results=events.slice(offset).filter(e=>e.type==='tool_result'&&e.sessionId===childId);
    const write=results.find(e=>e.name==='write'),command=results.find(e=>e.name===(process.platform==='win32'?'pwsh':'bash'));
    assert.equal(write?.isError,to==='approve',`${from} -> ${to}: native child file result`);
    assert.equal(command?.isError,to!=='auto',`${from} -> ${to}: native child command result`);
    if(to==='approve') {
      await assert.rejects(access(join(project,`${id}.txt`)));
      assert.match(JSON.stringify(write),/parent session policy/);
    } else assert.equal(await readFile(join(project,`${id}.txt`),'utf8'),id);
    assert.ok(results.some(e=>e.name==='send_message'&&!e.isError),'Native child reports back without human interaction');
  }
  assert.ok(calls.some(c=>c.sessionId===nativeId&&c.delegated===false),'A forked product id cannot turn its native root into a child');
  assert.ok(calls.some(c=>c.sessionId===childId&&c.delegated===true));
  assert.ok(events.some(e=>e.type==='tool_call'&&e.name==='send_message'&&e.internalControl===true));
  const reader=()=>createConversationDriver(driver,{readSession:id=>id===productId?structuredClone(session):undefined});
  const detail=await readSubagentConversation(session,{childSessionId:childId,ancestorSessionIds:[]},reader());
  assert.ok(detail.events.some(e=>e.type==='tool/result'&&e.data.message.isError),'Denied native receipts remain in child details');
  // Use the official teardown to flush native writers before a cold restore.
  await driver.close();driver=await createHarnessDriver({dataDir:join(root,'native'),cwd:project});
  await driver.createSession({sessionId:nativeId,cwd:project,provider,model:'fixture-model'});
  await mode('smart_approve');
  await driver.prompt(nativeId,'NI_PARENT_COLD',callbacks);
  assert.deepEqual((await driver.listSubagentChildren(nativeId)).map(c=>c.id),[childId]);
  assert.equal(await readFile(join(project,'COLD.txt'),'utf8'),'COLD');
  assert.equal((await listSubagentCatalog(session,{},reader())).children.length,1);
});
