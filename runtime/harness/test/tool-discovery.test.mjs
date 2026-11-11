import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessDriver} from '../index.mjs';

// Load native SDK consumers after the same serialized bootstrap as the driver.
const {installToolDiscovery, projectOptionalValues} = await import('../tool-discovery.mjs');

test('a failed undiscovered native call exposes its schema without replaying or granting execution', {timeout:60000}, async t => {
 const shell=process.platform==='win32'?'pwsh':'bash', requests=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const request=JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return;requests.push(request);
  const user=request.messages.findLastIndex(message=>message.role==='user');
  const results=request.messages.slice(user+1).filter(message=>message.role==='tool');
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'schema-repair',object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(results.length<2){
   const args={command:'echo DISCOVERY_SCHEMA_OK >> proof.txt',...(results.length?{description:'Write the isolated regression marker once'}:{})};
   emit({tool_calls:[{index:0,id:'shell-'+results.length,type:'function',function:{name:shell,arguments:JSON.stringify(args)}}]});emit({},'tool_calls');
  }else{emit({content:'done'});emit({},'stop');}
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(path.join(tmpdir(),'harness-schema-repair-'));
 const driver=await createHarnessDriver({dataDir:path.join(root,'state'),cwd:root});
 t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 for(const allow of [true,false]){
  const cwd=path.join(root,allow?'allowed':'denied');await mkdir(cwd);
  const session=await driver.createSession({cwd,provider:{id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:65536},model:'fixture'});
  const start=requests.length, approvals=[];
  await driver.prompt(session.sessionId,'Run the isolated schema repair fixture',{
   onToolPolicy:()=>({kind:'ask'}),onPermission:async({name})=>{approvals.push(name);return allow;},
  });
  const turns=requests.slice(start);
  assert.equal(turns[0].tools.some(tool=>tool.function.name===shell),false);
  const schema=turns[1].tools.find(tool=>tool.function.name===shell)?.function.parameters;
  assert.ok(schema?.required.includes('description'),'validation failure must reveal the canonical required field on the next request');
  assert.deepEqual(approvals,[shell,shell],'both proposals retain the normal execution approval gate');
  if(allow)assert.equal((await readFile(path.join(cwd,'proof.txt'),'utf8')).trim(),'DISCOVERY_SCHEMA_OK','invalid calls are not dispatched or replayed');
  else await assert.rejects(readFile(path.join(cwd,'proof.txt')), {code:'ENOENT'});
 }
});

test('result-driven discovery respects agent and registry boundaries', async()=>{
 let catalog=[{name:'bash',parameters:{type:'object'}}];const hooks=new Map();
 const ctx={tools:{schemas:()=>catalog,get(){},register(){}},systemPrompt:{section(){}},on(name,hook){hooks.set(name,hook);}};
 const agent={id:'owner',session:{requestHeader:()=>undefined}};
 installToolDiscovery(ctx,agent);
 const assemble=()=>hooks.get('system-prompt/assemble')({}, {}, async()=>({tools:catalog}));
 hooks.get('tools/result')({agent:{id:'peer'},name:'bash'},{isError:true});
 assert.deepEqual((await assemble()).tools,[]);
 hooks.get('tools/result')({agent,name:'bash'},{isError:true});
 assert.deepEqual((await assemble()).tools,catalog);
 catalog=[];
 assert.deepEqual((await assemble()).tools,[],'remembered selection cannot restore a revoked tool');
});

test('Ollama optional-value declarations preserve required nulls, payload data and the registry', async () => {
 const parameters = {type:'object',properties:{
   location:{type:['string','null'],description:'City',default:null},
   coordinates:{anyOf:[{$ref:'#/$defs/Coordinates'},{type:'null'}]},
   requiredNull:{type:['string','null']},
   nullOnly:{type:'null'},
   nested:{type:'object',properties:{enabled:{type:['boolean','null']}}},
   values:{type:'array',items:{type:['string','null']}},
   payload:{type:'object',default:{properties:{x:{type:['string','null']}}}},
 },required:['requiredNull'], $defs:{Coordinates:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'}},required:['latitude','longitude']}}};
 const original = structuredClone(parameters);
 const catalog = [{name:'mcp__queries__weather',parameters}];
 let hook,search,endpoint='https://ollama.com/v1';
 const ctx={tools:{schemas:()=>catalog,get:()=>search,register(t){search=t;}},systemPrompt:{section(){}},on(_n,h){hook=h;}};
 installToolDiscovery(ctx,{session:{requestHeader:()=>undefined}},()=>endpoint);
 const found = await search.execute({names:[catalog[0].name]});
 const projected = found.tools[0].parameters;
 assert.deepEqual(projected.properties.location,{type:'string',description:'City'});
 assert.deepEqual(projected.properties.coordinates,parameters.$defs.Coordinates);
 assert.deepEqual(projected.properties.requiredNull,original.properties.requiredNull);
 assert.deepEqual(projected.properties.nullOnly,original.properties.nullOnly);
 assert.deepEqual(projected.properties.values,original.properties.values,'null array entries are meaningful values');
 assert.deepEqual(projected.properties.payload,original.properties.payload,'defaults are data, not schemas');
 assert.equal(projected.properties.nested.properties.enabled.type,'boolean');
 assert.deepEqual(parameters,original,'discovery must not alter canonical validation');
 assert.deepEqual((await hook({}, {},async()=>({tools:catalog}))).tools[0].parameters,projected);
 endpoint='https://example.com/v1';
 assert.equal((await hook({}, {},async()=>({tools:catalog}))).tools[0],catalog[0],'model changes must not retain another route projection');
 assert.equal((await search.execute({names:[catalog[0].name]})).tools[0],catalog[0]);
});

test('optional projection does not overwrite intersecting union constraints', () => {
 const schema={type:'object',properties:{choice:{type:'number',anyOf:[{type:'integer',minimum:1},{type:'null'}]}}};
 const projected=projectOptionalValues(schema);
 assert.equal(projected.properties.choice.type,'number');
 assert.deepEqual(projected.properties.choice.anyOf,[{type:'integer',minimum:1}]);
 assert.deepEqual(schema.properties.choice.anyOf,[{type:'integer',minimum:1},{type:'null'}]);
});

test('model declaration references retain constraints, cycles and reference scopes', () => {
 const schema={type:'object',properties:{
   coordinate:{$ref:'#/$defs/alias',description:'Chosen coordinates'},
   constrained:{$ref:'#/$defs/number',minimum:5},
   recursive:{$ref:'#/$defs/node'},
   external:{$ref:'https://example.com/schema.json'},
   missing:{$ref:'#/$defs/missing'},
   escaped:{$ref:'#/$defs/a~1b~0c'},
   resource:{$id:'nested.json',$ref:'#/$defs/number'},
 },$defs:{
   alias:{$ref:'#/$defs/coordinate'},
   coordinate:{type:'object',properties:{latitude:{type:'number'}},required:['latitude']},
   number:{type:'number',minimum:1},
   node:{type:'object',properties:{next:{$ref:'#/$defs/node'}}},
   'a/b~c':{type:'string'},
 }};
 const original=structuredClone(schema);
 const result=projectOptionalValues(schema);
 assert.deepEqual(result.properties.coordinate,{...schema.$defs.coordinate,description:'Chosen coordinates'});
 assert.deepEqual(result.properties.constrained,{minimum:5,allOf:[schema.$defs.number]});
 assert.deepEqual(result.properties.recursive,schema.$defs.node);
 for(const name of ['external','missing','resource']) assert.deepEqual(result.properties[name],schema.properties[name]);
 assert.deepEqual(result.properties.escaped,{type:'string'});
 assert.deepEqual(schema,original);
});

test('native capabilities and guidance are loaded on demand without removing their registry entries', async () => {
 const names=['read','pwsh','edit','skill','project_memory','create_goal','subagent','job_list','web_fetch','load_workspace_dependencies'];
 const catalog=names.map(name=>({name,description:name,parameters:{type:'object',properties:{}}}));
 let hook,search;
 const ctx={tools:{schemas:()=>catalog,get:()=>search,register(t){search=t;}},systemPrompt:{section(){}},on(_n,h){hook=h;}};
 installToolDiscovery(ctx,{session:{requestHeader:()=>undefined}});
 const assembly=()=>({tools:catalog,sections:['tool:read','tool:pwsh','tool:edit','tool:goal','tool:subagent','tool:jobs','tool:web_fetch','tool:load_workspace_dependencies','sandbox'].map(name=>({name,text:name}))});
 const initial=await hook({}, {}, async()=>assembly());
 assert.deepEqual(initial.tools.map(t=>t.name),['read','edit','skill']);
 assert.deepEqual(initial.sections.map(s=>s.name),['tool:read','tool:edit','sandbox']);
 for(const name of names.slice(1).filter(name=>name!=='skill')) {
   const found=await search.execute({names:[name]});
   assert.equal(found.tools[0].name,name);
   assert.ok((await hook({}, {}, async()=>assembly())).tools.some(t=>t.name===name));
 }
 assert.deepEqual(ctx.tools.schemas().map(t=>t.name),names);
 const loaded=await hook({}, {}, async()=>assembly());
 assert.deepEqual(loaded.sections.map(s=>s.name),assembly().sections.map(s=>s.name));
});

test('delivery tools are present in the first request only when the scoped registry allows them', async () => {
 let hook;
 let catalog = ['read', 'write', 'edit', 'browser_control', 'pwsh'].map(name => ({ name }));
 installToolDiscovery({ tools: { schemas: () => catalog, get() {}, register() {} },
   systemPrompt: { section() {} }, on(_name, callback) { hook = callback; } },
   { session: { requestHeader: () => undefined } });
 const assemble = () => hook({}, {}, async () => ({ tools: catalog }));
 assert.deepEqual((await assemble()).tools.map(t => t.name), ['read', 'write', 'edit', 'browser_control']);
 catalog = catalog.filter(t => !['write', 'browser_control'].includes(t.name));
 assert.deepEqual((await assemble()).tools.map(t => t.name), ['read', 'edit']);
});

test('legacy full-catalog headers are not restored as selected tools', async () => {
 const catalog=Array.from({length:200},(_,i)=>({name:'mcp__old__tool_'+i}));
 let assemble;
 installToolDiscovery({tools:{schemas:()=>catalog,get(){},register(){}},systemPrompt:{section(){}},on(_name,hook){assemble=hook;}},
  {session:{requestHeader:()=>({tools:catalog})}});
 assert.deepEqual((await assemble({}, {}, async()=>({tools:catalog}))).tools,[]);
});

test('optional Git and role tools load through the same registry and restore only selected declarations', async()=>{
 const catalog=['read','git_status','subagent_coder'].map(name=>({name,description:name,parameters:{type:'object',properties:{}}}));
 let hook,search;
 const ctx={tools:{schemas:()=>catalog,get:()=>search,register(t){search=t;}},systemPrompt:{section(){}},on(_n,h){hook=h;}};
 installToolDiscovery(ctx,{session:{requestHeader:()=>undefined}});
 const assembly=()=>({tools:catalog,sections:[{name:'mcp:unused',text:'UNNEEDED_SERVER_GUIDANCE'},{name:'sandbox',text:'PRESERVE_POLICY'}]});
 assert.deepEqual((await hook({}, {}, async()=>assembly())).tools.map(t=>t.name),['read']);
 await search.execute({names:['git_status','subagent_coder']});
 const loaded=await hook({}, {}, async()=>assembly());
 assert.equal(loaded.tools.length,3);assert.deepEqual(loaded.sections.map(s=>s.name),['sandbox']);
 installToolDiscovery(ctx,{session:{requestHeader:()=>({tools:[{name:'search_mcp_tools'},catalog[1]]})}});
 assert.deepEqual((await hook({}, {}, async()=>assembly())).tools.map(t=>t.name),['read','git_status']);
});

test('MCP discovery reduces first request, loads callable schemas, preserves permissions and restart', {timeout:60000}, async t=>{
 const requests=[],calls=[];let initializations=0;
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let raw='';for await(const b of req)raw+=b;const m=JSON.parse(raw);
  if(replyToNoActionReview(m,res))return;
  if(req.url==='/mcp'){
   if(!('id' in m)){res.writeHead(202).end();return;}
   let result;
   if(m.method==='initialize'){initializations++;result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'catalog',version:'1'},instructions:'SERVER_GUIDANCE_ONLY_WHEN_LOADED'};}
   else if(m.method==='tools/list')result={tools:Array.from({length:200},(_,i)=>({name:'tool_'+i,description:(i===137?'Read verification marker. ':'Catalog documentation. ')+ 'schema notes '.repeat(120),inputSchema:{type:'object',properties:{}}}))};
   else if(m.method==='tools/call'){calls.push(m.params.name);result={content:[{type:'text',text:'VERIFIED_MARKER'}]};}
   else {res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));return;}
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));return;
  }
  requests.push(m);res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:m.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
  const last=m.messages.findLast(x=>x.role==='user');const prompt=JSON.stringify(last?.content);
  const toolResults=m.messages.slice(m.messages.indexOf(last)+1).filter(x=>x.role==='tool');
  if(prompt.includes('discover')&&!toolResults.length){emit({tool_calls:[{index:0,id:'search',type:'function',function:{name:'search_mcp_tools',arguments:JSON.stringify({names:['mcp__catalog__tool_137']})}}]});emit({},'tool_calls');}
  else if(prompt.includes('discover')&&toolResults.length===1){emit({tool_calls:[{index:0,id:'call',type:'function',function:{name:'mcp__catalog__tool_137',arguments:'{}'}}]});emit({},'tool_calls');}
  else {emit({content:'done'});emit({},'stop');}res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const root=await mkdtemp(path.join(tmpdir(),'harness-discovery-'));let driver=await createHarnessDriver({dataDir:path.join(root,'state'),cwd:root});
 t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const provider={id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:65536};
 const options={mcpServers:[{serverName:'catalog',transport:'streamable-http',url:`http://127.0.0.1:${server.address().port}/mcp`}]};
 const create=()=>driver.createSession({cwd:root,provider,model:'fixture',options});
 const a=await create();await driver.prompt(a.sessionId,'hello');
 assert.equal(requests.at(-1).tools.filter(x=>x.function.name.startsWith('mcp__')).length,0);
 assert.doesNotMatch(JSON.stringify(requests.at(-1).messages),/SERVER_GUIDANCE_ONLY_WHEN_LOADED/);
 assert.ok(JSON.stringify(requests.at(-1)).length<50000);
 assert.equal((await driver.listTools(a.sessionId)).filter(x=>x.name.startsWith('mcp__')).length,200);
 const events=[];
 await driver.prompt(a.sessionId,'discover verification marker',{onPermission:async()=>true,onEvent:event=>events.push(event)});
 assert.ok(events.some(event=>event.type==='tool_call'&&event.name==='search_mcp_tools'&&event.internalControl), 'Schema discovery remains an internal receipt, not a project operation');
 assert.ok(events.some(event=>event.type==='tool_call'&&event.name==='mcp__catalog__tool_137'&&!event.internalControl), 'The discovered tool execution remains visible');
 assert.ok(calls.includes('tool_137'));
 assert.match(JSON.stringify(requests.at(-1).messages),/SERVER_GUIDANCE_ONLY_WHEN_LOADED/);
 assert.equal(requests.at(-1).tools.filter(x=>x.function.name.startsWith('mcp__')).length,1);
 const b=await create();await driver.prompt(b.sessionId,'hello');
 assert.equal(requests.at(-1).tools.filter(x=>x.function.name.startsWith('mcp__')).length,0);assert.equal(initializations,1);
 const count=calls.length;
 const approvals=[];
 await driver.prompt(b.sessionId,'discover verification marker',{onPermission:async ({name})=>{approvals.push(name);return name==='search_mcp_tools';}});
 assert.ok(!approvals.includes('search_mcp_tools'),'loading tool schemas is read-only discovery, not an execution approval');
 assert.ok(approvals.includes('mcp__catalog__tool_137'));
 assert.equal(calls.length,count,'loading a tool must not bypass its execution permission');
 const explicit=await create(),explicitApprovals=[];
 await driver.prompt(explicit.sessionId,'hello');
 await driver.prompt(explicit.sessionId,'discover verification marker',{onToolPolicy:()=>({kind:'ask'}),onPermission:async ({name})=>{explicitApprovals.push(name);return name==='search_mcp_tools';}});
 assert.ok(explicitApprovals.includes('search_mcp_tools'),'an explicit ask policy still applies to discovery');
 assert.ok(explicitApprovals.includes('mcp__catalog__tool_137'));
 assert.equal(calls.length,count,'an explicit discovery grant does not approve the loaded tool');
 await driver.close();driver=await createHarnessDriver({dataDir:path.join(root,'state'),cwd:root});
 await driver.createSession({sessionId:a.sessionId,cwd:root,provider,model:'fixture',options});await driver.prompt(a.sessionId,'hello again');
 assert.ok(requests.at(-1).tools.some(x=>x.function.name==='mcp__catalog__tool_137'));
});
