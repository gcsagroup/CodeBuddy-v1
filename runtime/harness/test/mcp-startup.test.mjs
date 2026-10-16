import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';

test('remote MCP preparation does not serialize independent session-local MCP startup', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-parallel-mcp-'));
  const marker = path.join(root, 'local-ready');
  const script = path.join(root, 'stdio.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(!('id' in m))continue;
 if(m.method==='initialize')await writeFile(process.argv[2],'ready');
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}}:{tools:[]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}`);
  let overlapping = false, initializations = 0;
  const server = http.createServer(async (req, res) => {
    let body=''; for await(const part of req) body+=part;
    if(!body){res.writeHead(405).end();return;}
    const m=JSON.parse(body);
    if(!('id' in m)){res.writeHead(202).end();return;}
    if(m.method==='initialize'){
      initializations++;
      const deadline=Date.now()+3000;
      while(Date.now()<deadline){
        if(await access(marker).then(()=>true,()=>false)){overlapping=true;break;}
        await delay(10);
      }
    }
    const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}:{tools:[]};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const driver=await createHarnessDriver({dataDir:path.join(root,'harness'),cwd:root});
  t.after(()=>driver.close());
  const provider={id:'fixture',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'unused'};
  const options={mcpServers:[
    {serverName:'remote',transport:'streamable-http',url:`http://127.0.0.1:${server.address().port}/mcp`},
    {serverName:'local',transport:'stdio',command:process.execPath,args:[script,marker]},
  ]};
  await driver.createSession({cwd:root,provider,model:'fixture',options});
  assert.equal(overlapping,true,'stdio must connect while the remote server is still initializing');
  await driver.createSession({cwd:root,provider,model:'fixture',options});
  assert.equal(initializations,1,'the second session leases the original Harness remote scope');
});
