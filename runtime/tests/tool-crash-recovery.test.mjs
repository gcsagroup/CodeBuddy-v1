import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,appendFile,glob} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createHarnessDriver} from '../harness/index.mjs';
import {replyToNoActionReview} from '../harness/test/review-fixture.mjs';

for(const phase of ['before-effect','after-effect'])test(`Host loss while tool is running (${phase}) preserves history without automatic replay`,{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codebuddy-tool-crash-')),dataDir=path.join(root,'harness'),ledger=path.join(root,'effects.txt'),sessionId=randomUUID();
 let requests=0,driver,child;
 const endpoint=createServer(async(req,res)=>{
  let text='';for await(const c of req)text+=c;const body=JSON.parse(text);if(replyToNoActionReview(body,res))return;
  if(!body.stream)return res.end(JSON.stringify({choices:[{message:{content:'Synthetic crash test'}}]}));requests++;
  res.writeHead(200,{'content-type':'text/event-stream'});const emit=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'crash-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
  if(requests===1){emit({tool_calls:[{index:0,id:'effect-once',type:'function',function:{name:'fixture_effect',arguments:'{}'}}]});emit({},'tool_calls');}
  else{emit({content:'Recovered without running the uncertain tool again. Inspect its existing side effect before further action.'});emit({},'stop');}
  res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
 t.after(async()=>{if(child&&child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await driver?.close();endpoint.closeAllConnections();await new Promise(r=>endpoint.close(r));});
 const input={phase,root,dataDir,ledger,sessionId,provider:{id:'isolated-crash',baseUrl:`http://127.0.0.1:${endpoint.address().port}/v1`,apiKey:'synthetic-no-key'}};
 const file=path.join(root,'input.json');await writeFile(file,JSON.stringify(input));
 child=fork(new URL('./fixtures/tool-crash-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 const barrier=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>{throw Error('Worker exited before crash barrier: '+stderr);})]);
 assert.equal(barrier.stage,'tool-running');assert.equal(barrier.pid,child.pid);
 let journal;for await(const f of glob(path.join(dataDir,'sessions/**',sessionId,'session.v4.jsonl').replaceAll('\\','/')))journal=f;
 const original=await readFile(journal,'utf8'),events=original.trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.type==='tool/call').length,1);assert.equal(events.filter(e=>e.type==='tool/result').length,0);
 const death=once(child,'exit');assert.ok(child.kill('SIGKILL'));await death;
 const effectCount=async()=>{try{return (await readFile(ledger,'utf8')).trim().split('\n').filter(Boolean).length;}catch(e){if(e.code==='ENOENT')return 0;throw e;}};
 assert.equal(await effectCount(),phase==='after-effect'?1:0);
 driver=await createHarnessDriver({dataDir,cwd:root});
 const history=await driver.history(sessionId);assert.ok(history.events.length>0);
 assert.equal(requests,1,'Loading must not request inference');assert.equal(await effectCount(),phase==='after-effect'?1:0);
 await driver.createSession({sessionId,cwd:root,provider:input.provider,model:'crash-fixture',options:{tools:[{name:'fixture_effect',description:'Must not replay',inputSchema:{type:'object',properties:{}},async execute(){await appendFile(ledger,'REPLAY\n');return{replayed:true};}}]}});
 assert.equal(requests,1,'Restoring settings must not resume inference');
 await driver.prompt(sessionId,'Continue by reporting existing facts. Do not retry the uncertain operation.',{onPermission:()=>true});
 assert.equal(requests,2);assert.equal(await effectCount(),phase==='after-effect'?1:0);
 const after=await driver.exportSessionLog(sessionId);assert.ok(after.startsWith(original),'Original durable prefix must be retained');
 const restored=await driver.history(sessionId);
 assert.equal(restored.events.filter(e=>e.type==='tool/call').length,1);
 const unknown=restored.events.filter(e=>e.type==='tool/result'&&e.data.message.toolCallId==='effect-once');
 assert.equal(unknown.length,1);assert.equal(unknown[0].data.message.isError,true);
 assert.equal(unknown[0].data.error.code,'TOOL_OUTCOME_UNKNOWN');
 assert.equal(restored.events.find(e=>e.type==='turn/end'&&e.data.turn===1).data.reason.kind,'interrupted');
 assert.equal(restored.events.filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'completed');
});
