import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { developmentTools } from '../development-tools.mjs';
import staging from '../../scripts/stage-harness-distribution.cjs';
const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');
test('distribution rejects Serena dependencies prepared for a different platform', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cb-serena-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets', 'serena', 'serena'), { recursive: true });
  await writeFile(path.join(root, 'assets', 'serena', 'serena', 'cli.py'), '# isolated fixture');
  await writeFile(path.join(root, 'assets', 'serena-runtime.json'), JSON.stringify({ platform: 'invalid-target', arch: process.arch }));
  await assert.rejects(staging.copyRuntimeSources(root, path.join(root, 'out')), /Serena payload.*does not match/);
});
test('sprite bounds preserve empty cells and reject workspace escape', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cb-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await sharp({create:{width:8,height:4,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite([{input:await sharp({create:{width:2,height:2,channels:4,background:'red'}}).png().toBuffer(),left:1,top:1}]).png().toBuffer();
  await writeFile(path.join(root,'sprite.png'),image);
  const tool = developmentTools({cwd:root}).find(t=>t.name==='inspect_media');
  const result=await tool.execute({path:'sprite.png',columns:2});
  assert.deepEqual(result.stableBounds,{left:1,top:1,right:2,bottom:2});
  assert.equal(result.frames[1].bounds,null);
  assert.equal(result.frames[0].touchesEdge,false);
  await assert.rejects(tool.execute({path:'sprite.png',columns:3}),/divide/);
  await assert.rejects(tool.execute({path:fileURLToPath(import.meta.url)}),/inside the current workspace/);
});
test('documentation query returns source and propagates service failures', async () => {
  const tool=developmentTools({cwd:process.cwd(),request:async url=>{
    assert.equal(url.hostname,'context7.com');
    assert.equal(url.searchParams.get('libraryId'),'/reactjs/react.dev');
    return new Response('{"snippets":[]}');
  }}).find(t=>t.name==='library_docs');
  const result=await tool.execute({operation:'query',library:'/reactjs/react.dev',query:'useState'});
  assert.match(result.source,/libraryId=/);
  assert.equal(result.versionVerified,false);
  const unavailable=developmentTools({cwd:process.cwd(),request:async()=>new Response('',{status:429})}).find(t=>t.name==='library_docs');
  await assert.rejects(unavailable.execute({operation:'search',library:'react',query:'state'}),/429/);
});
