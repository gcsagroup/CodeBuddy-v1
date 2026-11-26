import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

for (const transport of ['streamable-http', 'stdio']) for (const permit of [true, false]) test(`same active turn discovers newly added MCP and skill; ${transport} permission=${permit}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'toolbox-hot-update-'));
  const skillDir = path.join(root, transport === 'stdio' ? 'shared/reconcile-ledger' : '.dsh/skills/reconcile-ledger');
  const requests = [], calls = [], approvals = [], errors = [];
  let configuration = { mcpServers: [] }, server;
  const tool = (name, args={}) => ({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const handle = async (req, res) => {
    let raw=''; for await (const chunk of req) raw+=chunk;
    if (!raw) { res.writeHead(405).end(); return; }
    const body=JSON.parse(raw);
    if (replyToNoActionReview(body,res)) return;
    if (req.url==='/mcp') {
      if (!('id' in body)) { res.writeHead(202).end(); return; }
      if (body.method==='tools/call') calls.push(body.params);
      const result=body.method==='initialize'
        ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ledger',version:'1'}}
        : body.method==='tools/list' ? {tools:[{name:'balance',description:'Read the authoritative ledger balance',inputSchema:{type:'object',properties:{}}}]}
          : {content:[{type:'text',text:'LEDGER_BALANCE_482_80'}]};
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
      return;
    }
    const step=requests.length; requests.push(body);
    const messages=JSON.stringify(body.messages);
    let delta;
    if (step===0) delta=tool('checkpoint',{phase:'add'});
    if (step===1) {
      assert.match(messages,/Updated skill index/,'native catalog publishes the changed availability');
      assert.doesNotMatch(messages,/never-enabled/,'installing a shared skill does not enable it');
      assert.doesNotMatch(messages,/PRIVATE_RECONCILIATION_BODY/,'new skill bodies remain deferred');
      assert.match(messages,/ledger/,'new MCP is visible as ready or connecting');
      assert.ok(!body.tools.some(t=>t.function.name==='mcp__ledger__balance'),'new service does not dump its schemas');
      delta=tool('search_mcp_tools',{kind:'skills',query:'reconcile'});
    }
    if (step===2) {
      assert.match(JSON.stringify(body.messages.filter(m=>m.role==='tool').at(-1)),/reconcile-ledger/,'new skill must be discoverable beyond the bounded index');
      assert.doesNotMatch(messages,/PRIVATE_RECONCILIATION_BODY/,'discovery does not load skill instructions');
      delta=tool('search_mcp_tools',{servers:['ledger']});
    }
    if (step===3) delta=tool('skill',{name:'reconcile-ledger'});
    if (step===4) {
      assert.match(messages,/PRIVATE_RECONCILIATION_BODY/);
      delta=tool('search_mcp_tools',{names:['mcp__ledger__balance']});
    }
    if (step===5) {
      assert.ok(body.tools.some(t=>t.function.name==='mcp__ledger__balance'));
      delta=tool('mcp__ledger__balance');
    }
    if (step===6) delta=tool('checkpoint',{phase:'remove'});
    if (step===7) {
      assert.ok(!body.tools.some(t=>t.function.name==='mcp__ledger__balance'),'removed tool schema must disappear');
      const system=JSON.stringify(body.messages.filter(m=>m.role==='system'));
      assert.doesNotMatch(system,/mcp__ledger__balance/,'current directory must not retain removed tool');
      delta=tool('search_mcp_tools',{kind:'skills',query:'reconcile'});
    }
    if (step===8) {
      const receipt=body.messages.filter(m=>m.role==='tool').at(-1);
      assert.equal(JSON.parse(receipt.content).totalMatches,0,'removed skills disappear from current discovery');
      delta={content:'DONE'};
    }
    assert.ok(delta,`Unexpected extra model request ${step}`);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({id:'hot',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.end(`data: ${JSON.stringify({id:'hot',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
  };
  server=http.createServer((req,res)=>handle(req,res).catch(e=>{errors.push(e);res.writeHead(200,{'content-type':'text/event-stream'}).end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'FIXTURE_ASSERTION_FAILED'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const stdioFile = path.join(root, 'mcp.mjs');
  await writeFile(stdioFile, `import readline from 'node:readline'; for await (const line of readline.createInterface({input:process.stdin})) { const b=JSON.parse(line); if(!('id' in b))continue; const r=await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/mcp`)},{method:'POST',body:line}); console.log(await r.text()); }`);
  const driver=await createHarnessDriver({dataDir:path.join(root,'data'),cwd:root,instructionsHome:root,sharedSkillDir:path.join(root,'shared')});
  t.after(async()=>{await driver.close();server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});});
  const checkpoint={name:'checkpoint',description:'Fixture operation boundary',inputSchema:{type:'object',properties:{phase:{type:'string'}},required:['phase']},execute:async({phase})=>{
    if(phase==='add'){
      await mkdir(skillDir,{recursive:true});
      await writeFile(path.join(skillDir,'SKILL.md'),'---\nname: reconcile-ledger\ndescription: Reconcile the authoritative ledger balance.\n---\nPRIVATE_RECONCILIATION_BODY\n');
      await mkdir(path.join(root,'shared/never-enabled'),{recursive:true});
      await writeFile(path.join(root,'shared/never-enabled/SKILL.md'),'---\nname: never-enabled\ndescription: Disabled shared candidate.\n---\nDo not load.\n');
      if (transport === 'stdio') {
        const candidate=(await driver.skillCatalog(root)).candidates.find(c=>c.name==='reconcile-ledger');
        const version=createHash('sha256').update(JSON.stringify([candidate.identity,candidate.rawDocument,candidate.sharedEnabled])).digest('hex');
        await driver.setSharedSkillEnabled(root,candidate.path,version,true);
      }
      configuration={mcpServers:[{serverName:'ledger',transport,...(transport==='stdio'?{command:process.execPath,args:[stdioFile]}:{url:`http://127.0.0.1:${server.address().port}/mcp`})}]};
    }else{
      configuration={mcpServers:[]};
      await rm(skillDir,{recursive:true,force:true});
    }
    return {changed:true};
  }};
  const {sessionId}=await driver.createSession({cwd:root,provider:{id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:65536},model:'fixture',options:{backgroundMcp:true,mcpServers:[],tools:[checkpoint],resolveMcpConfiguration:async()=>configuration,mainAgentRole:{baseline:()=>null,input:()=>null}}});
  const result=await driver.prompt(sessionId,'Reconcile the ledger using the tools available during the task.',{
    onToolPolicy:async tool=>({kind:tool.name==='mcp__ledger__balance'?'ask':'allow'}),
    onPermission:async tool=>{approvals.push(tool.name);return permit;},
  });
  assert.deepEqual(errors,[]);
  assert.equal(result.stopReason,'end_turn');
  assert.equal(requests.length,9,'one prompt continues without another user message');
  assert.deepEqual(approvals,['mcp__ledger__balance']);
  assert.equal(calls.length,permit?1:0,'discovery never grants execution permission');
  assert.ok(!(await driver.listSkills(sessionId)).some(s=>s.name==='reconcile-ledger'));
});
