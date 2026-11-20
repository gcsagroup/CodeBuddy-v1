import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { webAuditTool } from '../web-audit-tool.mjs';
test('browser audit finds overflow and unlabeled controls in a real browser', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'cb-web-audit-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'index.html'),'<!doctype html><html lang="en"><title>Audit fixture</title><main style="width:900px"><button></button></main></html>');
  const tool=webAuditTool({cwd:root});
  const result=await tool.execute({path:'index.html',width:390});
  assert.ok(result.viewport.documentWidth>390);
  assert.ok(result.violations.some(item=>item.id==='button-name'));
  await assert.rejects(tool.execute({path:'../../outside.html'}));
});
