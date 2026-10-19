import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { RuntimeSettings } from '../settings.mjs';
import { driverProvider, thinkingProfile } from '../providers.mjs';
import { applyModelThinking, modelThinkingOptions, modelThinkingPreference } from '../model-settings.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { catalogThinkingProfile } from '../harness/model-catalog.mjs';

test('official model capabilities supply the actual offered levels without invented off or extra-high controls', () => {
  const profile = catalogThinkingProfile('openai', 'gpt-6.1-sol');
  const options = modelThinkingOptions(profile);
  assert.deepEqual(options.options, ['low','medium','high','xhigh','max']);
  assert.equal(options.value,'medium');
  assert.equal(modelThinkingOptions({reasoningEfforts:false}).options.length,0);
  assert.deepEqual(modelThinkingOptions({reasoningEfforts:{high:'high'}}).options,['high']);
});

test('Ollama profiles, per-connection preferences, persistence and actual DSH requests share one control', {timeout:30000}, async t => {
  const requests=[];
  const models=['toggle','graded','fixed'];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req) raw+=chunk;
    const body=raw?JSON.parse(raw):{};
    if(req.url==='/api/tags'){res.setHeader('content-type','application/json');res.end(JSON.stringify({models:models.map(name=>({name}))}));return;}
    if(req.url==='/api/show'){
      const values=body.model==='toggle'?[false,true]:body.model==='fixed'?['high']:['low','medium','high'];
      res.setHeader('content-type','application/json');res.end(JSON.stringify({capabilities:['completion','thinking'],thinking:{values,default:body.model==='fixed'?'high':'medium'}}));return;
    }
    requests.push(body);res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'thinking',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if(body.reasoning_effort && body.reasoning_effort!=='none')emit({reasoning_content:'A bounded reasoning fixture.'});
    emit({content:'391'});emit({},'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=await mkdtemp(path.join(tmpdir(),'model-thinking-preferences-'));
  const store=await openStore(path.join(root,'host'));
  const base={engine:'ollama_compatible',apiUrl:`http://127.0.0.1:${server.address().port}`,models,requiresAuth:false};
  await store.update(state=>{state.providers=[{...base,id:'A'},{...base,id:'B'}];state.preferences.gooseThinkingEffort='medium';});
  const settings=new RuntimeSettings(store);
  for(const model of models)await driverProvider({...base,id:'A'},model);
  const read=async(id,model)=>JSON.parse((await settings.request('providers/config/read',{providerId:id})).fields.find(field=>field.key===`thinkingEffort:${model}`).value);
  assert.deepEqual((await read('A','toggle')).options,['none','medium']);
  assert.equal((await read('A','toggle')).toggle,true);
  assert.deepEqual((await read('A','graded')).options,['low','medium','high']);
  assert.deepEqual((await read('A','fixed')).options,['high']);
  await assert.rejects(settings.request('providers/config/save',{providerId:'A',fields:[{key:'thinkingEffort:toggle',value:'high'}]}),/unavailable/);
  await settings.request('providers/config/save',{providerId:'A',fields:[{key:'thinkingEffort:toggle',value:'none'}]});
  await settings.request('providers/config/save',{providerId:'A',fields:[{key:'thinkingEffort:graded',value:'high'}]});
  assert.equal((await read('A','toggle')).value,'none');assert.equal((await read('A','graded')).value,'high');
  assert.equal((await read('B','toggle')).value,'medium');
  const reloaded=await openStore(path.join(root,'host'));
  assert.deepEqual(reloaded.read(['providers']).providers.find(p=>p.id==='A').thinkingEfforts,{toggle:'none',graded:'high'});
  assert.equal(reloaded.read(['preferences']).preferences.gooseThinkingEffort,'medium');
  const driver=await createHarnessDriver({dataDir:path.join(root,'native'),cwd:root});
  t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  for(const model of ['toggle','graded']){
    const provider=store.read(['providers']).providers.find(p=>p.id==='A');
    const native=await driverProvider(provider,model);
    assert.equal(Object.hasOwn(native,'thinkingToggle'),false,'Presentation metadata must not enter native connection identities');
    const selected=applyModelThinking(native,modelThinkingPreference(thinkingProfile(provider,model),provider.thinkingEfforts[model],store.read(['preferences']).preferences.gooseThinkingEffort));
    const session=await driver.createSession({cwd:root,provider:selected.provider,model,options:{thinkingEffort:selected.thinkingEffort}}),events=[];
    assert.equal((await driver.prompt(session.sessionId,'17*23',{onEvent:event=>events.push(event)})).stopReason,'end_turn');
    assert.equal(requests.at(-1).reasoning_effort,model==='toggle'?'none':'high');
    assert.equal(requests.at(-1).chat_template_kwargs,undefined);
    assert.equal(events.some(event=>event.type==='thinking_delta'),model!=='toggle');
  }
});
