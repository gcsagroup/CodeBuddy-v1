import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
test('history search joins message chunks without joining separate messages and searches projects',async()=>{
 const store=await openStore(await mkdtemp(join(tmpdir(),'cb-history-search-')));
 const now=new Date().toISOString();
 await store.update(s=>{s.sessions=[{id:'split',title:'排查记录',cwd:'D:/projects/CodeBuddy',type:'user',createdAt:now,updatedAt:now,updates:[
 {sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:'修复历史'}},
 {sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:'记录搜索'}},
 {sessionUpdate:'user_message_chunk',messageId:'b',content:{type:'text',text:'边界甲'}},
 {sessionUpdate:'user_message_chunk',messageId:'c',content:{type:'text',text:'边界乙'}}]}];});
 const host=new Compat(store,{});
 const find=async query=>(await host.request('session/list',{_meta:{query}})).sessions.map(s=>s.sessionId);
 assert.deepEqual(await find('历史记录'),['split']);
 assert.deepEqual(await find('codebuddy'),['split']);
 assert.deepEqual(await find('甲边界乙'),[]);
 assert.deepEqual(await find('不存在'),[]);
});

test('search includes archived legacy bodies and current live text without modifying history',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {mkdir}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'cb-legacy-search-'));const archiveId='legacy-'+ 'a'.repeat(24);
 await mkdir(join(dir,'legacy',archiveId),{recursive:true});const db=new DatabaseSync(join(dir,'legacy',archiveId,'sessions.db'));
 db.exec('CREATE TABLE sessions(id TEXT,session_type TEXT,name TEXT,working_dir TEXT,created_at TEXT,updated_at TEXT);CREATE TABLE messages(id INTEGER,message_id TEXT,session_id TEXT,role TEXT,content_json TEXT,created_timestamp INTEGER,metadata_json TEXT);');
 db.prepare('INSERT INTO sessions(id,session_type) VALUES(?,?)').run('old','user');db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(1,'m','old','user',JSON.stringify([{type:'text',text:'旧记录专属关键词'}]),1791950400,'{}');db.close();
 const store=await openStore(dir);const now=new Date().toISOString();
 await store.update(s=>{s.sessions=[{id:'legacy',type:'user',title:'Old',cwd:'',createdAt:now,updatedAt:now,archivedAt:now,updates:[],legacyHistory:{archiveId,sessionId:'old'}},{id:'live',type:'user',title:'Current',cwd:'',createdAt:now,updatedAt:now,updates:[]}];});
 const host=new Compat(store,{});host.active.set('live',{replay:{turnId:'t',users:[],usageUpdates:[],updates:[{sessionUpdate:'agent_message_chunk',messageId:'m',content:{type:'text',text:'实时'}},{sessionUpdate:'agent_message_chunk',messageId:'m',content:{type:'text',text:'正文'}}]}});
 const find=async(query,includeArchived=false)=>(await host.request('session/list',{_meta:{query,includeArchived}})).sessions.map(s=>s.sessionId);
 assert.deepEqual(await find('旧记录'),[]);assert.deepEqual(await find('旧记录',true),['legacy']);assert.deepEqual(await find('实时正文'),['live']);
 assert.deepEqual(store.readSession('live').updates,[]);
});

test('cached searches reuse only committed visible text and invalidate same-timestamp edits and deletes',async()=>{
 const store=await openStore(await mkdtemp(join(tmpdir(),'cb-search-cache-')));const now=new Date().toISOString();
 await store.update(s=>{s.sessions=[{id:'a',title:'record',cwd:'',type:'user',createdAt:now,updatedAt:now,updates:[{sessionUpdate:'user_message_chunk',messageId:'u',content:{type:'text',text:'ＡＢＣ 实收22'}},{sessionUpdate:'agent_thought_chunk',messageId:'t',content:{type:'text',text:'隐含干扰'}}]}];});
 let reads=0;const observed={...store,readSession(...args){reads++;return store.readSession(...args);}};const host=new Compat(observed,{});
 const find=async query=>(await host.request('session/list',{_meta:{query}})).sessions.map(s=>s.sessionId);
 assert.deepEqual(await find('abc'),['a']);assert.deepEqual(await find('实收22'),['a']);assert.deepEqual(await find('隐含干扰'),[]);assert.equal(reads,1);
 await store.updateSession('a',s=>{s.updates[0].content.text='修改后的正文';});assert.deepEqual(await find('实收22'),[]);assert.deepEqual(await find('修改后'),['a']);assert.equal(reads,2);
 await store.acceptSessionDeletion('a');assert.deepEqual(await find('修改后'),[]);assert.equal(host.history.searchCache.size,0);
});
