import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WindowsSessionTemps} from '../../harness/windows-session-temps.mjs';

// Exercise Node's own onErrorNT/error/close sequence without exhausting the
// machine's handles. No ChildProcess events are synthesized by this fixture.
const {Process}=process.binding('process_wrap');
const {UV_EMFILE}=process.binding('uv');
const original=Process.prototype.spawn;
let injected=false;
Process.prototype.spawn=function(...args){
  if(!injected){injected=true;return UV_EMFILE;}
  return original.apply(this,args);
};
const root=await mkdtemp(join(tmpdir(),'codebuddy-resource-no-stdio-'));
const resources=new WindowsSessionTemps();
const policy={workspaceRoot:root,sessionId:'failed-native-spawn'};
const acquire=()=>resources.acquire(policy,undefined,performance.now()+5000);
const outcome=p=>p.then(value=>({value}),error=>({error}));
try{
  const first=outcome(acquire());
  const failed=resources.retiring;
  const retry=outcome(acquire());
  assert.equal(injected,true);
  assert.ok(failed,'the failed child must remain owned until real close');
  assert.equal(failed.child.pid,undefined);
  assert.equal(failed.child.stderr,undefined);
  assert.match((await first).error?.message??'',/did not start/);
  assert.match((await retry).error?.message??'',/previous TEMP resource owner has not exited/);
  await failed.closed;
  const recovered=await acquire();await access(recovered.dir);
  console.log('NATIVE_SPAWN_FAILURE_HANDLED_AND_RECOVERED');
}finally{
  Process.prototype.spawn=original;
  await resources.close();
  await rm(root,{recursive:true,force:true});
}
