import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { builtinMcp } from '../builtin-extensions.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

test('Windows standalone browser inherits OS lookup roots and retains isolated browser storage', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-browser-env-')));
  const before = { ...process.env };
  try {
    const config = await builtinMcp({type:'builtin',name:'playwright'}, {cwd:root,dataDir:root});
    assert.ok(config.args.includes('--isolated'));
    assert.ok(!config.args.includes('--extension'));
    const lookupRoots = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']);
    for (const key of Object.keys(config.env)) assert.ok(!lookupRoots.has(key.toUpperCase()), key);
    for (const key of ['TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CODEBUDDY_HOME']) {
      const relative = path.relative(path.join(root, 'tool-runtime', 'playwright'), config.env[key]);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), key);
    }
    assert.equal(config.args[config.args.indexOf('--output-dir') + 1], path.join(root, 'tool-runtime', 'playwright', 'cache'));
    assert.deepEqual({ ...process.env }, before);
  } finally {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, {recursive:true,force:true});
  }
});

test('bundled Playwright MCP opens a real browser, clicks and verifies the result through Harness', { timeout: 90000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-browser-mcp-')));
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<title>Browser acceptance</title><button onclick="this.textContent=\'已验证\'">验收按钮</button>'); });
  let driver;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const config = await builtinMcp({type:'builtin',name:'playwright'}, {cwd:root,dataDir:root});
    assert.equal(config.command,process.execPath);
    assert.ok(config.args.includes('--isolated'));
    assert.ok(!config.args.includes('--extension'));
    const user = await builtinMcp({type:'builtin',name:'playwright_user'}, {cwd:root,dataDir:root});
    assert.ok(user.args.includes('--extension'));
    assert.equal(user.env.USERPROFILE,undefined);
    assert.equal(user.env.HOME,undefined);
    driver = await createHarnessDriver({dataDir:path.join(root,'harness'),cwd:root});
    const {sessionId} = await driver.createSession({cwd:root,provider:{id:'offline',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'unused'},model:'fixture',options:{mcpServers:[config]}});
    const call = async (name,args={}) => { const result = await driver.callTool(sessionId,`mcp__playwright__${name}`,args,{onPermission:()=>true}); assert.equal(result.isError,false,JSON.stringify(result.content)); return JSON.stringify(result.content); };
    await call('browser_navigate',{url:`http://127.0.0.1:${server.address().port}`});
    const page = await call('browser_snapshot');
    const ref = page.match(/button \\\"验收按钮\\\" \[ref=(e\d+)\]/)?.[1] ?? page.match(/验收按钮.*?\[ref=(e\d+)\]/)?.[1];
    assert.ok(ref, page);
    await call('browser_click',{element:'验收按钮',target:ref});
    assert.match(await call('browser_snapshot'),/已验证/);
    await call('browser_close');
  } finally {
    await driver?.close();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
