import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { shellReader } from '../harness/windows-shell-output.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

test('Windows shell output preserves UTF-8, legacy lines, byte offsets, and independent readers', () => {
  let bytes = Buffer.from([0xc6]);
  const reader = shellReader({
    readFrom(offset) { return { text: bytes.subarray(offset).toString(), nextOffset: bytes.length, lossy: false }; },
    snapshot() { return { bytes, totalBytes: bytes.length }; },
  }, () => false);
  assert.equal(reader.readFrom(0).nextOffset, 0);
  bytes = Buffer.concat([bytes, Buffer.from([0xf4,0xb6,0xaf]), Buffer.from('.ps1 项目🚀\n')]);
  const first = reader.readFrom(0);
  assert.equal(first.text, '启动.ps1 项目🚀\n');
  assert.equal(reader.readFrom(0).text, first.text);
  bytes = Buffer.concat([bytes, Buffer.from('中文名称.ps1\n')]);
  assert.equal(reader.readFrom(first.nextOffset).text, '中文名称.ps1\n');
});

test('actual Windows shell resolves named project scripts and reads original stdout/stderr bytes', {skip:process.platform !== 'win32'}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'codebuddy-project-script-'));
  const cwd = path.join(root,'项目 A');
  const other = path.join(root,'项目 B');
  const sub = path.join(cwd,'脚本');
  const second = path.join(cwd,'其他');
  await Promise.all([cwd,other,sub,second].map(dir=>mkdir(dir,{recursive:true})));
  const body = "$n=[IO.Path]::GetFileName($PSCommandPath); [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'ran.txt'),$n+[Environment]::NewLine); Write-Output $n";
  await Promise.all([[cwd,'运行.ps1'],[sub,"中 文[1]'名.ps1"],[other,'启动.ps1'],[sub,'重复.ps1'],[second,'重复.ps1']].map(([dir,name])=>writeFile(path.join(dir,name),body)));
  await symlink(other,path.join(cwd,'外部链接'),'junction');
  const nested = path.join(cwd,'独立仓库');
  await mkdir(path.join(nested,'.git'),{recursive:true});
  await writeFile(path.join(nested,'启动.ps1'),body);
  const driver = await createHarnessDriver({cwd,dataDir:path.join(root,'state')});
  t.after(()=>driver.close());
  const {sessionId} = await driver.createSession({cwd,model:'fixture',provider:{id:'offline',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'unused'}});
  const run = async (command, options = {}) => {
    const result = await driver.callTool(sessionId,'pwsh',{description:'Verify isolated project script',command,...options},{onPermission:()=>true});
    return result;
  };
  const invoke = name => run("Invoke-CodeBuddyProjectScript -LiteralPath '" + name.replaceAll("'", "''") + "'");
  for (const [name,error] of [['启动.ps1','not found'],['重复.ps1','Multiple project files'],['外部链接/启动.ps1','not found'],['../项目 B/启动.ps1','Invalid project-relative']]) {
    const receipt = await invoke(name);
    assert.ok(receipt.isError || receipt.value.exitCode !== 0);
    const message = receipt.content.map(block=>block.text).join('\n');
    assert.ok(message.includes(error),message);
  }
  await assert.rejects(readFile(path.join(other,'ran.txt')),{code:'ENOENT'});
  await assert.rejects(readFile(path.join(nested,'ran.txt')),{code:'ENOENT'});
  await assert.rejects(readFile(path.join(cwd,'ran.txt')),{code:'ENOENT'});
  for (const name of ["中 文[1]'名.ps1","脚本/中 文[1]'名.ps1"]) {
    const {value:receipt} = await invoke(name);
    assert.equal(receipt.exitCode,0,receipt.stderr.text);
    assert.ok(receipt.stdout.text.includes(path.join(sub,"中 文[1]'名.ps1")));
  }
  assert.deepEqual((await readFile(path.join(sub,'ran.txt'),'utf8')).trim().split(/\r?\n/),Array(2).fill("中 文[1]'名.ps1"));
  const {value:receipt} = await run("$b=[byte[]](0xc6,0xf4,0xb6,0xaf,0x2e,0x70,0x73,0x31); foreach($s in @([Console]::OpenStandardOutput(),[Console]::OpenStandardError())){$s.Write($b,0,$b.Length);$s.Flush()}");
  assert.equal(receipt.stdout.text,'启动.ps1');
  assert.equal(receipt.stderr.text,'启动.ps1');
  await writeFile(path.join(cwd,'参数.ps1'), 'Write-Output ($args -join "|"); exit 7');
  const {value:withArgs} = await run("Invoke-CodeBuddyProjectScript -LiteralPath '参数.ps1' -ArgumentList '中文 参数','[1]'");
  assert.equal(withArgs.exitCode,7);
  assert.ok(withArgs.stdout.text.includes('中文 参数|[1]'));
  await writeFile(path.join(cwd,'目录.ps1'),'Write-Output (Get-Location).Path');
  const fromSibling = await run("Invoke-CodeBuddyProjectScript -LiteralPath '目录.ps1'", {workdir:other});
  assert.ok(fromSibling.content.some(b=>b.text?.includes('working directory is outside this project')));
});

test('a missing script closes tool execution for that input, including a proposed substitute, until the next user turn', {skip:process.platform !== 'win32'}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'codebuddy-script-turn-'));
  const cwd = path.join(root,'project');
  await mkdir(cwd);
  const marker = path.join(cwd,'ran.txt');
  await writeFile(path.join(cwd,'运行.ps1'), "[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'ran.txt'),'1')");
  const server = createServer(async (req,res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body,res)) return;
    const index = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('fixture_script_'));
    const prompt = JSON.stringify(body.messages[index]?.content);
    const first = prompt.includes('fixture_script_missing');
    const inspectAfterRun = prompt.includes('fixture_script_inspect');
    const count = body.messages.slice(index+1).filter(m=>m.role==='tool').length;
    // Deliberately propose the near-match even if the host removed its schema.
    const name = count < 2 ? (first && count === 0 ? '启动.ps1' : '运行.ps1') : null;
    const command = inspectAfterRun && count === 1 ? "Get-Content -LiteralPath 'ran.txt'" :
      "Invoke-CodeBuddyProjectScript -LiteralPath '" + name + "'" + (inspectAfterRun ? ' -ContinueTask' : '');
    const selecting = body.tools?.some(tool=>tool.function?.name === 'select_project_script');
    const selection = {mode:inspectAfterRun ? 'other' : 'run_only',path:inspectAfterRun ? '' : (first ? '启动.ps1' : '运行.ps1')};
    const delta = selecting ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',
      function:{name:'select_project_script',arguments:JSON.stringify(selection)}}]} :
      name ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{
      name:'pwsh',arguments:JSON.stringify({description:'Run or verify the selected project script',command})}}]} :
      {role:'assistant',content:first ? '当前项目找不到启动.ps1。' : '运行.ps1 已执行。'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for (const [piece,finish_reason] of [[delta,null],[{},selecting || name ? 'tool_calls' : 'stop']])
      res.write('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:piece,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const driver = await createHarnessDriver({cwd,dataDir:path.join(root,'state')});
  t.after(()=>driver.close());
  const sessionId = randomUUID();
  // Desktop can establish the permission session before its first model is selected.
  await driver.permissions(sessionId,{cwd,initialPreset:'workspace-write'});
  await driver.createSession({sessionId,cwd,provider:{id:'fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',protocol:'openai-completions',apiKey:'fixture'},model:'fixture'});
  const callbacks={onPermission:()=>true};
  await driver.prompt(sessionId,'fixture_script_missing 帮我运行启动.ps1',callbacks);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  const {events} = await driver.history(sessionId);
  assert.equal(events.filter(e=>e.type==='tool/call' && e.data.name==='pwsh').length,2);
  assert.equal(events.filter(e=>e.type==='tool/result' && e.data.message.isError).length,2);
  await driver.prompt(sessionId,'fixture_script_new 那就运行运行.ps1',callbacks);
  assert.equal(await readFile(marker,'utf8'),'1');
  await driver.prompt(sessionId,'fixture_script_inspect 运行运行.ps1，然后读取 ran.txt 核对结果',callbacks);
  assert.equal(await readFile(marker,'utf8'),'11');
  const after = (await driver.history(sessionId)).events.filter(e=>e.type==='tool/result').at(-1);
  assert.equal(after.data.message.isError,false);
  assert.ok(after.data.message.content.some(b=>b.text?.trim()==='11'));
});
