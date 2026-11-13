import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHarnessDriver} from '../index.mjs';
import {contextUpdates} from '../../context-updates.mjs';
import {zGooseSessionNotification_unstable} from '../../../ui/sdk/src/generated/zod.gen.ts';

test('live stream updates survive SDK parsing; one multi-step turn compacts repeatedly before completion', {timeout:60000}, async t => {
  let calls=0, summaries=0, completed=false;
  const updates=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const p of req)raw+=p;
    const body=JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    const last=body.messages.at(-1)?.content;
    const text=typeof last==='string'?last:(last??[]).map(block=>block.text??'').join('\n');
    const summary=text.startsWith('You are now acting as a compaction engine for this AI coding assistant.');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'live',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if(summary){summaries++;emit({content:'Goal: complete eight fixture steps. Preserve API A and requirement B. Continue remaining steps.'});emit({},'stop');}
    else if(calls<8){
      emit({content: `Step ${calls} analysis: ` + 'Preserve API A and requirement B; verified module facts. '.repeat(450)});
      emit({tool_calls:[{index:0,id:'c'+calls,type:'function',function:{name:'fixture_step',arguments:'{}'}}]});emit({},'tool_calls');
    } else {
      for(let n=0;n<4;n++){emit({content:'Verified module output. '.repeat(80)});await delay(300);}
      emit({},'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const root=await mkdtemp(join(tmpdir(),'harness-live-context-'));
  const driver=await createHarnessDriver({cwd:root,dataDir:join(root,'state')});
  t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const s=await driver.createSession({cwd:root,provider:{id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:65536,maxTokens:2048,contextSource:'configured'},model:'fixture',options:{autoCompactThreshold:0.25,tools:[{name:'fixture_step',parameters:{type:'object',properties:{}},execute:async()=>{calls++;return {content:[{type:'text',text:`Completed step ${calls}. `+'file facts and verification results '.repeat(600)}]};}}]}});
  const project=contextUpdates({sessionId:s.sessionId});
  const events=[];
  const result=await driver.prompt(s.sessionId,'Develop the fixture across eight steps; preserve API A and requirement B.',{onPermission:()=>true,onEvent:event=>{
    events.push(event);
    for(const update of project(event))updates.push({beforeCompletion:!completed,update:zGooseSessionNotification_unstable.parse({sessionId:s.sessionId,update}).update});
  }});completed=true;
  assert.equal(result.stopReason,'end_turn');assert.equal(calls,8);
  const compact=events.filter(e=>e.type==='harness_event'&&e.event.type==='compaction/end'&&!e.event.data.error);
  assert.ok(compact.length>=2,`expected multiple within-turn compactions, got ${compact.length}; summaries ${summaries}`);
  const live=updates.filter(e=>e.update.status?.data?.event==='context_meter'&&e.update.status.data.source==='streaming_estimate');
  assert.ok(live.length>=3);assert.ok(live.every(e=>e.beforeCompletion));
  assert.ok(new Set(live.map(e=>e.update.status.data.used)).size>=3);
  assert.equal(live.at(-1).update.status.data.contextSource,'configured');
  const usage=events.filter(e=>e.type==='context_usage'&&e.source!=='streaming_estimate');
  assert.ok(usage.some((e,i)=>i>0&&e.used<usage[i-1].used),'native compaction must lower the displayed durable meter');
  assert.equal(usage.at(-1).used,(await driver.contextUsage(s.sessionId)).used,'stream estimate must not double count committed output');
});
