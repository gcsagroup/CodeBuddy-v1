import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { RuntimeSettings } from '../settings.mjs';
import { discover, driverProvider, resolvedModelInfo, thinkingProfile } from '../providers.mjs';
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

test('fresh profiles read mixed Ollama Cloud efforts without breaking other model details', async t => {
  // Public /api/show shapes captured on 2026-10-19; no account credentials.
  const metadata = {
    'gemma4:31b': { thinking: { values: [false, true], default: false }, model_info: { 'gemma4.context_length': 262144 } },
    'glm-5.2': { thinking: { values: [false, 'high', 'max'], default: 'high' }, model_info: { 'glm5.2.context_length': 1048576 } },
    'deepseek-v4.1-flash:1017': { thinking: { values: [false, 'low', 'high', 'max'], default: 'high' } },
    'invalid-advisory-default': { thinking: { values: [false, 'high'], default: 'max' } },
  };
  const models = Object.keys(metadata);
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://ollama.com');
    if (url.pathname === '/api/tags') return Response.json({ models: models.map(name => ({ name, capabilities: ['completion'] })) });
    assert.equal(url.pathname, '/api/show');
    const { model } = JSON.parse(options.body);
    assert.ok(Object.hasOwn(metadata, model));
    return Response.json({ capabilities: ['completion', 'thinking'], ...metadata[model] });
  });
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-thinking-mixed-'));
  const store = await openStore(root);
  const provider = { id: 'mixed-cloud', engine: 'openai_compatible', apiUrl: 'https://ollama.com', models, requiresAuth: false };
  await store.update(state => { state.providers = [provider]; });
  const native = new Map();
  for (const model of models) native.set(model, await driverProvider(provider, model));
  const settings = new RuntimeSettings(store);
  for (const legacy of [undefined, 'medium']) {
    await store.update(state => {
      if (legacy === undefined) delete state.preferences.gooseThinkingEffort;
      else state.preferences.gooseThinkingEffort = legacy;
    });
    const { fields } = await settings.request('providers/config/read', { providerId: provider.id });
    const read = (kind, model) => JSON.parse(fields.find(field => field.key === `${kind}:${model}`).value);
    assert.deepEqual(read('thinkingEffort', 'glm-5.2'), { options: ['none', 'high', 'max'], value: 'high', toggle: false });
    assert.deepEqual(read('thinkingEffort', 'deepseek-v4.1-flash:1017'), { options: ['none', 'low', 'high', 'max'], value: 'high', toggle: false });
    assert.deepEqual(read('thinkingEffort', 'gemma4:31b'), { options: ['none', 'medium'], value: 'medium', toggle: true });
    assert.equal(read('contextWindow', 'gemma4:31b').contextWindow, 262144);
    assert.equal(read('contextWindow', 'glm-5.2').contextWindow, 1048576);
    assert.equal(read('thinkingEffort', 'invalid-advisory-default').value, 'high');
    const selected = applyModelThinking(native.get('glm-5.2'), modelThinkingPreference(thinkingProfile(provider, 'glm-5.2'), undefined, legacy));
    assert.equal(selected.thinkingEffort, 'high');
  }
  await assert.rejects(settings.request('providers/config/save', {
    providerId: provider.id, fields: [{ key: 'thinkingEffort:glm-5.2', value: 'medium' }],
  }), /unavailable/);
  await store.update(state => { state.providers[0].thinkingEfforts = { 'glm-5.2': 'medium' }; });
  const staleRead = await settings.request('providers/config/read', { providerId: provider.id });
  assert.equal(JSON.parse(staleRead.fields.find(field => field.key === 'thinkingEffort:glm-5.2').value).value, 'high');
  assert.equal(modelThinkingPreference(thinkingProfile(provider, 'glm-5.2'), 'medium'), 'high');
  assert.equal(store.read().providers[0].thinkingEfforts['glm-5.2'], 'medium', 'Reading new capabilities must not overwrite an older user preference');
});

for (const invalidation of ['expiry', 'model-list refresh']) {
  test(`thinking saves resolve the selected model after metadata ${invalidation}`, async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const model = 'deepseek-v4.1-flash';
    const models = ['other-first-model', model];
    let values = [false, 'low', 'high', 'max'];
    let offline = false;
    const lookups = [];
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      if (offline) throw new Error('Fixture offline');
      const url = new URL(input);
      assert.equal(url.origin, 'https://ollama.com');
      if (url.pathname === '/api/tags') return Response.json({ models: models.map(name => ({ name })) });
      assert.equal(url.pathname, '/api/show');
      const selected = JSON.parse(options.body).model;
      lookups.push(selected);
      return Response.json(selected === model
        ? { capabilities: ['completion', 'thinking'], thinking: { values, default: 'low' } }
        : { capabilities: ['completion'] });
    });
    const root = await mkdtemp(path.join(tmpdir(), 'thinking-save-refresh-'));
    const store = await openStore(root);
    const provider = { id: 'save-refresh', engine: 'openai_compatible', apiUrl: 'https://ollama.com', models, requiresAuth: false, headers: { 'x-fixture': invalidation } };
    await store.update(state => { state.providers = [provider]; });
    const settings = new RuntimeSettings(store);
    await resolvedModelInfo(provider, model);
    const { fields } = await settings.request('providers/config/read', { providerId: provider.id });
    const offered = JSON.parse(fields.find(field => field.key === `thinkingEffort:${model}`).value);
    assert.deepEqual(offered, { options: ['none', 'low', 'high', 'max'], value: 'low', toggle: false });
    if (invalidation === 'expiry') now += 5 * 60_000 + 1;
    else await discover(provider, provider);

    const save = value => settings.request('providers/config/save', {
      providerId: provider.id, fields: [{ key: `thinkingEffort:${model}`, value }],
    });
    await save('high');
    assert.equal(store.read(['providers']).providers[0].thinkingEfforts[model], 'high');
    const refreshed = lookups.length;
    assert.equal(lookups.at(-1), model, 'Saving must resolve the selected model, even when it is not first in the connection');
    await save('max');
    assert.equal(lookups.length, refreshed, 'A warm save reuses the existing bounded metadata cache');
    assert.equal((await openStore(root)).read(['providers']).providers[0].thinkingEfforts[model], 'max');
    await assert.rejects(save('medium'), /unavailable/);

    now += 5 * 60_000 + 1;
    values = [false, 'low'];
    await assert.rejects(save('high'), /unavailable/, 'Real capability changes still reject removed levels');
    assert.equal(store.read(['providers']).providers[0].thinkingEfforts[model], 'max');
    offline = true;
    await settings.request('providers/config/save', {
      providerId: provider.id, fields: [], clearFields: [`thinkingEffort:${model}`],
    });
    assert.equal(store.read(['providers']).providers[0].thinkingEfforts[model], undefined, 'Clearing a preference does not require a reachable provider');
  });
}

test('thinking metadata fetched for an old connection cannot validate a save to its replacement', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const model = 'deepseek-v4.1-flash';
  const provider = { id: 'replaced', engine: 'openai_compatible', apiUrl: 'https://ollama.com', models: [model], requiresAuth: false, headers: { 'x-fixture': 'replacement' } };
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).pathname === '/api/tags') return Response.json({ models: [{ name: model }] });
    started.resolve();
    await finish.promise;
    return Response.json({ capabilities: ['completion', 'thinking'], thinking: { values: ['low', 'high'], default: 'low' } });
  });
  const store = await openStore(await mkdtemp(path.join(tmpdir(), 'thinking-save-replaced-')));
  await store.update(state => { state.providers = [provider]; });
  const settings = new RuntimeSettings(store);
  const pending = settings.request('providers/config/save', {
    providerId: provider.id, fields: [{ key: `thinkingEffort:${model}`, value: 'high' }],
  });
  await started.promise;
  await store.update(state => { state.providers[0].apiUrl = 'https://replacement.invalid'; });
  finish.resolve();
  await assert.rejects(pending, /connection changed/);
  assert.equal(store.read(['providers']).providers[0].thinkingEfforts, undefined);
});

test('model details survive a model-list refresh while the selected model lookup is pending', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const model = 'deepseek-v4.1-flash';
  const provider = { id: 'read-refresh-race', engine: 'openai_compatible', apiUrl: 'https://ollama.com',
    models: ['other-first-model', model], requiresAuth: false, headers: { 'x-fixture': 'read-refresh-race' } };
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://ollama.com');
    if (url.pathname === '/api/tags') return Response.json({ models: provider.models.map(name => ({ name })) });
    assert.equal(url.pathname, '/api/show');
    const selected = JSON.parse(options.body).model;
    if (selected !== model) return Response.json({ capabilities: ['completion'] });
    if (++reads === 1) { started.resolve(); await finish.promise; }
    return Response.json({ capabilities: ['completion', 'thinking'],
      thinking: { values: [false, 'low', 'high', 'max'], default: 'high' },
      model_info: { 'deepseek.context_length': 1048576 } });
  });
  const pending = resolvedModelInfo(provider, model);
  await started.promise;
  await discover(provider, provider);
  finish.resolve();
  assert.deepEqual(await pending, { provider: provider.id, model, contextLimit: 1048576,
    contextSource: 'service', reasoning: true, currency: 'USD' });
  const settings = new RuntimeSettings({ read: () => ({ providers: [provider], preferences: {} }) });
  const { fields } = await settings.request('providers/config/read', { providerId: provider.id });
  const read = kind => JSON.parse(fields.find(field => field.key === `${kind}:${model}`).value);
  assert.deepEqual(read('thinkingEffort'), { options: ['none', 'low', 'high', 'max'], value: 'high', toggle: false });
  assert.equal(read('contextWindow').contextSource, 'service');
  assert.equal(read('contextWindow').contextWindow, 1048576);
  await resolvedModelInfo(provider, model);
  assert.equal(reads, 2, 'A superseded lookup retries once; warm reads keep the existing cache');
});
