import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileSavedWorkflow, savedWorkflowCatalog, selectSavedWorkflow, prepareSavedWorkflow } from '../comfyui-saved-workflows.mjs';
import { comfyuiTool } from '../comfyui-tool.mjs';
import { savedFixtureGraphs, savedFixtureInventory } from './comfyui-catalog-fixture.mjs';
import { workflowCandidates } from '../comfyui-workflows.mjs';

function uiFixture() {
  const input = (name, link = null, widget = true) => ({ name, link, ...(widget ? { widget: { name } } : {}) });
  return { id: 'fixture', version: 0.4, groups: [{ title: 'My layout', bounding: [1,2,3,4] }],
    nodes: [
      { id: 1, type: 'FixtureModel', pos:[50,60], inputs:[], widgets_values_named:{} },
      { id: 2, type: 'sub', pos:[200,60], inputs:[input('prompt'),input('steps')], widgets_values:['Saved prompt',18], widgets_values_named:{prompt:'Saved prompt',steps:18} },
      { id: 3, type:'SaveImage', pos:[500,60], inputs:[input('images',1,false),input('filename_prefix')], widgets_values:['saved'],widgets_values_named:{filename_prefix:'saved'} },
    ], links:[[1,2,0,3,0,'IMAGE']], definitions:{subgraphs:[{
      id:'sub',inputNode:{id:-10},outputNode:{id:-20},inputs:[{name:'prompt'},{name:'steps'}],
      nodes:[
        {id:10,type:'TextEncodeQwenImage21',inputs:[input('prompt',2),input('negative_prompt')],widgets_values:['internal','negative'],widgets_values_named:{prompt:'internal',negative_prompt:'negative'}},
        {id:11,type:'KSampler',inputs:[input('positive',3,false),input('steps',4),input('seed')],widgets_values:[25,8],widgets_values_named:{steps:25,seed:8}},
        {id:12,type:'VAEDecode',inputs:[input('samples',5,false)]},
      ],links:[
        {id:2,origin_id:-10,origin_slot:0,target_id:10,target_slot:0},
        {id:3,origin_id:10,origin_slot:0,target_id:11,target_slot:0},
        {id:4,origin_id:-10,origin_slot:1,target_id:11,target_slot:1},
        {id:5,origin_id:11,origin_slot:0,target_id:12,target_slot:0},
        {id:6,origin_id:12,origin_slot:0,target_id:-20,target_slot:0},
      ],groups:[]
    }]}
  };
}
const info = {...savedFixtureInventory,FixtureModel:{input:{required:{}},output:['MODEL']},SaveImage:{input:{required:{filename_prefix:['STRING']}},output:[]}};

test('all supplied video variants bind requested seconds and retain their original frame calculations', async () => {
  for (const [mode, count] of [['text_to_video', 0], ['image_to_video', 1], ['reference_to_video', 2]]) {
    for (const spec of workflowCandidates('video', mode, count)) {
      const source = structuredClone(spec.graph);
      const catalog = await savedWorkflowCatalog(reader({ 'clip.json': source }), info, 'video', mode, count);
      const entry = selectSavedWorkflow(catalog, {});
      const refs = Array.from({ length: count }, (_, i) => `uploaded-${i}.png`);
      const defaults = prepareSavedWorkflow(entry, { prompt: 'Rabbit', seed: 1 }, refs, 'job', info);
      for (const seconds of [20, 30, 60, 20.5]) {
        const result = prepareSavedWorkflow(entry, { prompt: 'Rabbit', seed: 1, duration_seconds: seconds }, refs, 'job', info);
        const expected = structuredClone(defaults.graph);
        expected[spec.durationNode].inputs.value = seconds;
        assert.deepEqual(result.graph, expected);
      }
      assert.deepEqual(source, spec.graph);
    }
  }
});
function reader(files) {return async route=>{
  if(route.startsWith('/userdata?'))return Object.keys(files);
  const file=decodeURIComponent(route.slice('/userdata/'.length)).replace(/^workflows\//,'');
  if(!files[file])throw Error('not found');return structuredClone(files[file]);
};}

test('saved subgraph promotion and layout survive parameter binding; original stays unchanged',async()=>{
  const source=uiFixture(), before=structuredClone(source);
  const c=await savedWorkflowCatalog(reader({'custom.json':source}),info,'image',undefined,0);
  assert.equal(c.public.creation_allowed,false);assert.equal(c.public.blockers.length,0);
  const entry=selectSavedWorkflow(c,{});
  const result=prepareSavedWorkflow(entry,{prompt:'NEW',seed:42},[],'job',info);
  assert.equal(result.graph['2:11'].inputs.steps,18);
  assert.equal(result.graph['2:10'].inputs.prompt,'NEW');
  assert.equal(result.graph['2:10'].inputs.negative_prompt,'negative');
  assert.deepEqual(result.graph['2:11'].inputs.positive,['2:10',0]);
  assert.deepEqual(result.ui.groups,source.groups);
  assert.deepEqual(result.ui.nodes[1].pos,source.nodes[1].pos);
  assert.equal(result.ui.nodes[1].widgets_values_named.prompt,'NEW');
  assert.equal(result.ui.nodes[1].widgets_values[0],'NEW');
  const reparsed=compileSavedWorkflow(result.ui,info).graph;
  for(const [id,n] of Object.entries(result.graph))assert.deepEqual(reparsed[id].inputs,n.inputs);
  assert.deepEqual(source,before);
});

test('generation rereads saved file after inspect, sends original layout, and never falls back to the bundled copy',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codebuddy-saved-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=uiFixture(), files={'custom.json':source};let submitted;
  const tool=comfyuiTool({cwd:root,dataDir:root,sessionId:'test',baseUrl:'http://fixture',fetchImpl:async(url,options)=>{
    const route=new URL(url).pathname+new URL(url).search;
    if(route==='/object_info')return Response.json(info);
    if(route.startsWith('/userdata'))return Response.json(await reader(files)(route));
    assert.equal(route,'/prompt');submitted=JSON.parse(options.body);return Response.json({prompt_id:submitted.prompt_id});
  }});
  const inspection=await tool.execute({operation:'inspect'});
  assert.equal(inspection.workflows[0].id,'saved:custom.json');
  source.nodes[1].widgets_values_named.steps=7;source.nodes[1].widgets_values[1]=7;
  const receipt=await tool.execute({operation:'generate',workflow_id:'saved:custom.json',prompt:'A rabbit',seed:13,request_id:randomUUID()});
  assert.equal(receipt.workflow.source,'workflows/custom.json');
  assert.equal(submitted.prompt['2:11'].inputs.steps,7);
  assert.equal(submitted.prompt['2:11'].inputs.seed,13);
  assert.equal(submitted.extra_data.preview_method,'none');
  assert.equal(submitted.extra_data.extra_pnginfo.workflow.nodes[1].widgets_values_named.prompt,'A rabbit');
  assert.deepEqual(submitted.extra_data.extra_pnginfo.workflow.groups,source.groups);
});

test('multiple matching saved workflows require an explicit Agent selection, including two text-video variants',async()=>{
  const c=await savedWorkflowCatalog(reader({'one.json':uiFixture(),'two.json':uiFixture()}),info,'image',undefined,0);
  assert.throws(()=>selectSavedWorkflow(c,{}),/2 compatible/);
  assert.equal(selectSavedWorkflow(c,{workflow_id:'saved:two.json'}).file,'two.json');
  assert.throws(()=>selectSavedWorkflow(c,{workflow_id:'qwen_image'}),/Select/);
  const video=savedFixtureGraphs['minimax_text.json'];
  const v=await savedWorkflowCatalog(reader({'quality.json':video,'fast.json':video}),info,'video','text_to_video',0);
  assert.equal(v.public.workflows.filter(w=>w.compatible).length,2);
  assert.equal(v.public.creation_allowed,false);
});

test('missing dependencies or no saved files allow fallback; read failures and unsupported formats do not',async()=>{
  assert.equal((await savedWorkflowCatalog(reader({}),info,'image',undefined,0)).public.creation_allowed,true);
  const missing={...info};delete missing.KSampler;
  const c=await savedWorkflowCatalog(reader({'missing.json':uiFixture()}),missing,'image',undefined,0);
  assert.equal(c.public.creation_allowed,true);assert.ok(c.public.workflows[0].missing.some(x=>x.name==='KSampler'));
  const unsupported=uiFixture();unsupported.nodes[1].mode=4;
  const u=await savedWorkflowCatalog(reader({'unsupported.json':unsupported}),info,'image',undefined,0);
  assert.equal(u.public.creation_allowed,false);assert.equal(u.public.blockers.length,1);
  await assert.rejects(savedWorkflowCatalog(async()=>{throw Error('offline');},info,'image',undefined,0),/offline/);
  await assert.rejects(savedWorkflowCatalog(async()=>['../other.json'],info,'image',undefined,0),/invalid/);
});

test('fallback submission rechecks newly available saved workflows and rejects before enqueue',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codebuddy-saved-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const files={};let submissions=0;
  const tool=comfyuiTool({cwd:root,dataDir:root,sessionId:'gate',baseUrl:'http://fixture',fetchImpl:async(url)=>{
    const route=new URL(url).pathname+new URL(url).search;
    if(route==='/object_info')return Response.json(info);
    if(route.startsWith('/userdata'))return Response.json(await reader(files)(route));
    submissions++;throw Error('Unexpected enqueue');
  }});
  assert.equal((await tool.execute({operation:'inspect'})).creation_allowed,true);
  files['new.json']=uiFixture();
  await assert.rejects(tool.execute({operation:'generate',prompt:'hello',fallback_workflow:{},request_id:randomUUID()}),/existing workflow/);
  assert.equal(submissions,0);
});

test('API saved graphs retain models, negative prompts and all edges; references bind uploaded data',async()=>{
  const graph=savedFixtureGraphs['qwen_edit.json'];
  const c=await savedWorkflowCatalog(reader({'edit.json':graph}),info,'image','image_to_image',1);
  const e=selectSavedWorkflow(c,{}), p=prepareSavedWorkflow(e,{prompt:'reference edit',seed:1},['uploaded.png'],'job',info);
  assert.equal(p.graph['470'].inputs.image,'uploaded.png');assert.equal(p.graph['475'].inputs.image,'uploaded.png');
  assert.equal(p.graph['459:453'].inputs.clip_name,graph['459:453'].inputs.clip_name);
  assert.equal(p.ui,null);
  assert.equal((await savedWorkflowCatalog(reader({'edit.json':graph}),info,'image',undefined,0)).public.workflows[0].compatible,false);
});

test('ambiguous computed prompt and cycles block reuse without silently replacing the graph',async()=>{
  const source=structuredClone(savedFixtureGraphs['qwen_image.json']);
  source['459:452'].inputs.prompt=['13',0];
  const c=await savedWorkflowCatalog(reader({'computed.json':source}),info,'image',undefined,0);
  assert.equal(c.public.creation_allowed,false);assert.match(c.public.blockers[0].error,/computed/);
  source['13'].inputs.cycle=['461',0];
  const cyclic=await savedWorkflowCatalog(reader({'cycle.json':source}),info,'image',undefined,0);
  assert.equal(cyclic.public.creation_allowed,false);assert.match(cyclic.public.blockers[0].error,/cycle/);
});
