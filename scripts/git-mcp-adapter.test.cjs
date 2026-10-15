const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {execFileSync}=require('node:child_process');
const {normalizeGitArguments,parseGitStatus,patchedBundle}=require('./git-mcp-adapter.cjs');

test('real porcelain preserves Chinese paths, spaces, rename direction and conflicts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codebuddy-git-parser-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
 try {
  git('init','-b','main');git('config','core.autocrlf','false');git('config','user.name','Acceptance');git('config','user.email','acceptance@example.invalid');git('config','commit.gpgsign','false');
  fs.writeFileSync(path.join(root,'原 文件.txt'),'original\n');git('add','.');git('commit','-m','base');
  git('mv','原 文件.txt','新 文件.txt');fs.writeFileSync(path.join(root,'另一个 草稿.txt'),'keep me');
  let state=parseGitStatus(git('status','--porcelain=v2','-b','-z'));
  assert.deepEqual(state.stagedChanges.renamed,['原 文件.txt -> 新 文件.txt']);assert.deepEqual(state.untrackedFiles,['另一个 草稿.txt']);
  git('commit','-m','rename');git('branch','peer');
  fs.writeFileSync(path.join(root,'新 文件.txt'),'main\n');git('add','新 文件.txt');git('commit','-m','main side');
  git('checkout','peer');fs.writeFileSync(path.join(root,'新 文件.txt'),'peer\n');git('add','新 文件.txt');git('commit','-m','peer side');git('checkout','main');
  assert.throws(()=>git('merge','peer'));
  state=parseGitStatus(git('status','--porcelain=v2','-b','-z'));
  assert.deepEqual(state.conflictedFiles,['新 文件.txt']);assert.equal(state.isClean,false);assert.equal(fs.readFileSync(path.join(root,'另一个 草稿.txt'),'utf8'),'keep me');
  git('merge','--abort');assert.equal(fs.readFileSync(path.join(root,'新 文件.txt'),'utf8'),'main\n');
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('NUL records preserve whitespace and escaped-looking names without decoding or trimming',()=>{
 const state=parseGitStatus('# branch.head main\0?  leading space.txt\0? literal\\346.txt\0? tab\tline\n.txt\0');
 assert.deepEqual(state.untrackedFiles,[' leading space.txt','literal\\346.txt','tab\tline\n.txt']);
 assert.equal(parseGitStatus('# branch.head main\0').isClean,true);
 assert.throws(()=>parseGitStatus('2 R. N... 100644 100644 100644 abc def R100 new'));
});

test('unknown upstream versions fail before producing an unverified adapter',()=>{
 assert.throws(()=>patchedBundle('changed upstream source'));
});


test('Windows canonical paths retain location while other device paths remain untouched', {skip:process.platform!=='win32'},()=>{
 const drive={path:String.raw`\\?\D:\项目\工作 仓库`,other:'keep'};
 assert.deepEqual(normalizeGitArguments(drive),{path:String.raw`D:\项目\工作 仓库`,other:'keep'});
 assert.equal(normalizeGitArguments({path:String.raw`\\?\UNC\server\share\repo`}).path,String.raw`\\server\share\repo`);
 const device={path:String.raw`\\?\GLOBALROOT\Device\disk`};assert.equal(normalizeGitArguments(device),device);
 assert.equal(normalizeGitArguments({path:String.raw`\\?\D:\allowed\..\outside`}).path,String.raw`D:\allowed\..\outside`);
});
