import {appendFile,readFile} from 'node:fs/promises';
import {createHarnessDriver} from '../../harness/index.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const driver=await createHarnessDriver({dataDir:input.dataDir,cwd:input.root});
await driver.createSession({sessionId:input.sessionId,cwd:input.root,provider:input.provider,model:'crash-fixture'});
await driver.configureSession(input.sessionId,{tools:[{name:'fixture_effect',description:'Append one synthetic side effect',inputSchema:{type:'object',properties:{}},async execute(){
  if(input.phase==='after-effect')await appendFile(input.ledger,'effect\n');
  // Flush the proposal and previous history, but deliberately do not return a
  // tool receipt. The parent kills this isolated Host at this exact boundary.
  await driver.exportSessionLog(input.sessionId);
  process.send({stage:'tool-running',pid:process.pid});
  await new Promise(()=>{});
}}]});
await driver.prompt(input.sessionId,'Execute the synthetic tool once, then report.',{onPermission:()=>true});
throw Error('Crash barrier unexpectedly returned');
