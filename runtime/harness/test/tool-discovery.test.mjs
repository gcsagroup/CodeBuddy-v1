import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessDriver} from '../index.mjs';
import {installToolDiscovery} from '../tool-discovery.mjs';

test('native capabilities and guidance are loaded on demand without removing their registry entries', async () => {
 const names=['read','pwsh','edit','skill','project_memory','create_goal','subagent','job_list','web_fetch','load_workspace_dependencies'];
 const catalog=names.map(name=>({name,description:name,parameters:{type:'object',properties:{}}}));
 let hook,search;
 const ctx={tools:{schemas:()=>catalog,get:()=>search,register(t){search=t;}},systemPrompt:{section(){}},on(_n,h){hook=h;}};
 installToolDiscovery(ctx,{session:{requestHeader:()=>undefined}});
 const assembly=()=>({tools:catalog,sections:['tool:read','tool:pwsh','tool:edit','tool:goal','tool:subagent','tool:jobs','tool:web_fetch','tool:load_workspace_dependencies','sandbox'].map(name=>({name,text:name}))});
 const initial=await hook({}, {}, async()=>assembly());
 assert.deepEqual(initial.tools.map(t=>t.name),['read']);
 assert.deepEqual(initial.sections.map(s=>s.name),['tool:read','sandbox']);
 for(const name of names.slice(1)) {
   const found=await search.execute({names:[name]});
   assert.equal(found.tools[0].name,name);
   assert.ok((await hook({}, {}, async()=>assembly())).tools.some(t=>t.name===name));
 }
 assert.deepEqual(ctx.tools.schemas().map(t=>t.name),names);
 const loaded=await hook({}, {}, async()=>assembly());
 assert.deepEqual(loaded.sections.map(s=>s.name),assembly().sections.map(s=>s.name));
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
 await driver.prompt(a.sessionId,'discover verification marker',{onPermission:async()=>true});
 assert.ok(calls.includes('tool_137'));
 assert.match(JSON.stringify(requests.at(-1).messages),/SERVER_GUIDANCE_ONLY_WHEN_LOADED/);
 assert.equal(requests.at(-1).tools.filter(x=>x.function.name.startsWith('mcp__')).length,1);
 const b=await create();await driver.prompt(b.sessionId,'hello');
 assert.equal(requests.at(-1).tools.filter(x=>x.function.name.startsWith('mcp__')).length,0);assert.equal(initializations,1);
 const count=calls.length;
 const approvals=[];
 await driver.prompt(b.sessionId,'discover verification marker',{onPermission:async ({name})=>{approvals.push(name);return name==='search_mcp_tools';}});
 assert.ok(approvals.includes('search_mcp_tools'));
 assert.ok(approvals.includes('mcp__catalog__tool_137'));
 assert.equal(calls.length,count,'loading a tool must not bypass its execution permission');
 await driver.close();driver=await createHarnessDriver({dataDir:path.join(root,'state'),cwd:root});
 await driver.createSession({sessionId:a.sessionId,cwd:root,provider,model:'fixture',options});await driver.prompt(a.sessionId,'hello again');
 assert.ok(requests.at(-1).tools.some(x=>x.function.name==='mcp__catalog__tool_137'));
});
