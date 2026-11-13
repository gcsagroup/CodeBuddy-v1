import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,glob} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// Match Harness startup before importing the engine for failure injection.
import '../harness/sdk-budget-contract.mjs';
import {createCompatServer} from '../server.mjs';
import {replyToNoActionReview} from '../harness/test/review-fixture.mjs';
const {default:CompactionEngine}=await import('../harness/compaction.mjs');

test('actual summary failures publish safe native reasons and preserve them across reconnect and restart', {timeout:60000}, async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codebuddy-compaction-diagnostic-'));
  const privateText='PRIVATE_KEY_COOKIE_USER_PATH_192.0.2.17';
  let mode='success', requestCount=0, brokenObserver=false;
  const dependencies=CompactionEngine.prototype.regionDependencies;
  t.mock.method(CompactionEngine.prototype,'regionDependencies',function(){
    const original=dependencies.call(this);
    return {...original,onFailure(...args){if(brokenObserver)throw Error('PRIVATE_OBSERVER_FAILURE');return original.onFailure(...args);}};
  });
  const endpoint=createServer(async(req,res)=>{
    if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:[{id:'fixture',context_window:65536}]}));
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(replyToNoActionReview(body,res))return;
    if(!body.stream)return res.end(JSON.stringify({choices:[{message:{content:'Isolated test'}}]}));
    requestCount++;
    const summary=JSON.stringify(body.messages.at(-1)).includes('compaction engine');
    if(summary&&mode==='auth')return res.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({error:{message:privateText,code:'invalid_api_key'}}));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'diagnostic-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    const content=summary ? mode==='empty'?'':mode==='not_smaller'?'Repeated archive cannot be a smaller checkpoint. '.repeat(3000):'Retain ORION-739. The completed command must not be repeated. Next: verify.' : 'Completed synthetic archive. '.repeat(900);
    emit({role:'assistant',content});emit({},summary&&mode==='truncated'?'length':'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
  const secret='isolated-compaction-diagnostics-secret',dataDir=path.join(root,'data');
  let app,ws,serial=0,notifications=[];const pending=new Map();
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timeout '+method));},20000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
  const ext=(name,params)=>rpc('_goose/unstable/'+name,params);
  const connect=async()=>{
    app=await createCompatServer({dataDir,secret});
    ws=new WebSocket((await app.listen()).replace('http:','ws:')+'/acp?token='+secret);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    ws.onmessage=({data})=>{
      const message=JSON.parse(String(data)),entry=pending.get(message.id);
      if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Object.assign(Error(message.error.message),{data:message.error.data})):entry.resolve(message.result);}
      else notifications.push(message);
    };
    await rpc('initialize',{protocolVersion:1,clientCapabilities:{}});
  };
  t.after(async()=>{ws?.close();await app?.close();endpoint.closeAllConnections();await new Promise(r=>endpoint.close(r));});
  await connect();
  const {providerId}=await ext('providers/custom/create',{engine:'openai_compatible',displayName:'Isolated diagnostics',apiUrl:`http://127.0.0.1:${endpoint.address().port}`,models:['fixture'],requiresAuth:false,supportsStreaming:true});
  await ext('defaults/save',{providerId,modelId:'fixture'});
  const {sessionId}=await rpc('session/new',{cwd:root,mcpServers:[],_meta:{enabledExtensions:[]}});
  const prompt=text=>rpc('session/prompt',{sessionId,prompt:[{type:'text',text}]});
  await prompt('Preserve ORION-739; complete the synthetic archive.');
  await prompt('Wait for the next instruction. Do not use tools.');
  const lifecycle=()=>notifications.filter(n=>n.method==='_goose/unstable/session/update').map(n=>n.params.update.status?.data).filter(d=>d?.event==='compaction_lifecycle');
  for(const [failureMode,code] of [['auth','AUTH'],['empty','EMPTY_RESPONSE'],['truncated','MAX_TOKENS'],['not_smaller','COMPACTION_NOT_SMALLER']]){
    mode=failureMode;const before=lifecycle().length;
    await prompt('/compact').catch(()=>{});
    const changes=lifecycle().slice(before);
    assert.equal(changes.length,2);assert.equal(changes[0].status,'started');assert.equal(changes[1].status,'failed');
    assert.equal(changes[1].operation_id,changes[0].operation_id);assert.equal(changes[1].diagnostic.code,code);
    assert.equal(JSON.stringify(changes).includes(privateText),false);
    const sent=requestCount;
    await rpc('session/load',{sessionId,cwd:root,mcpServers:[]});
    assert.equal(requestCount,sent,'reloading a failed summary must not generate');
    assert.equal(lifecycle().at(-1).diagnostic.code,code);
  }
  const sent=requestCount;
  ws.close();await app.close();notifications=[];await connect();
  await rpc('session/load',{sessionId,cwd:root,mcpServers:[]});
  assert.equal(requestCount,sent);assert.deepEqual(lifecycle().filter(d=>d.status==='failed').map(d=>d.diagnostic.code),['AUTH','EMPTY_RESPONSE','MAX_TOKENS','COMPACTION_NOT_SMALLER']);
  assert.equal(notifications.some(n=>n.params?.update?.status?.data?.terminal_message_id?.startsWith('failed:')),false,
    'Manual compaction errors keep their lifecycle instead of becoming ordinary-chat failures');
  assert.equal(JSON.stringify(lifecycle()).includes(privateText),false);
  mode='auth';brokenObserver=true;
  const originalFailure=await prompt('/compact').then(()=>null,error=>error);
  assert.equal(originalFailure.data.diagnostic.code,'AUTH','diagnostic observer failure must not replace the native failure');
  assert.equal(lifecycle().at(-1).diagnostic.code,'UNKNOWN_FAILURE','a failed optional observer degrades only the public diagnostic');
  brokenObserver=false;
  mode='success';await prompt('/compact');
  assert.equal(lifecycle().at(-1).status,'completed');assert.equal(lifecycle().at(-1).diagnostic,undefined,'previous model errors must not poison a successful transaction');
  await prompt('Continue without tools.');
  const {data}=await ext('session/log/export',{sessionId});
  assert.equal(JSON.parse(data.split('\n')[0]).type,'diagnostic-export');
  assert.equal(data.includes(privateText),false);
  const files=[];for await(const file of glob(path.join(dataDir,'harness/sessions/**',sessionId,'session.v4.jsonl').replaceAll('\\','/')))files.push(file);
  assert.equal(files.length,1);
  const events=(await readFile(files[0],'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='compaction/start').length,6);
  const ends=events.filter(e=>e.type==='compaction/end');
  assert.equal(ends.length,6);assert.ok(ends.slice(0,5).every(e=>typeof e.data.error==='string'),'native durable error format is unchanged');
  assert.equal(ends[4].data.error.includes('PRIVATE_OBSERVER_FAILURE'),false);
  assert.equal(ends.at(-1).data.error,undefined);assert.equal(events.filter(e=>e.type==='compaction/summary').length,1);
  assert.equal(events.filter(e=>e.type==='tool/call').length,0);
  const saved=JSON.parse(await readFile(path.join(dataDir,'state.json'),'utf8'));
  assert.ok(saved.sessions.some(s=>s.id===sessionId));
});
