'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { chromium } = require(require.resolve('playwright', { paths: [path.join(root, 'ui', 'desktop')] }));
(async () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, '.preview-evidence', 'first-version-fixture.json')));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.devtoolsPort}`);
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://localhost:'));
  page.setDefaultTimeout(20000);
  await page.bringToFront();
  const errors = []; const choosers = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('filechooser', () => choosers.push('unexpected file chooser'));
  try {
    const action = process.argv[2] ?? 'new';
    if (action === 'new') {
      await page.getByRole('button', { name: '新任务', exact: true }).click();
      await page.locator('#dynamic-textarea').fill('验证默认工作区：请回复 CODEPRO_DEFAULT_WORKSPACE_OK。');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('CODEPRO_DEFAULT_WORKSPACE_OK', { exact: true }).first().waitFor({ timeout: 60000 });
      const state = JSON.parse(fs.readFileSync(path.join(config.profile, 'backend', 'state.json')));
      const session = state.sessions.at(-1);
      assert.ok(session.cwd.startsWith(path.join(config.profile, 'workspaces') + path.sep));
      assert.ok(fs.statSync(session.cwd).isDirectory());
      assert.equal(session.type, 'code_pro'); assert.equal(choosers.length, 0);
      console.log(JSON.stringify({ sessionId: session.id, cwd: session.cwd, route: page.url(), unexpectedFileChoosers: choosers, pageErrors: errors }));
    } else if (action === 'close-window') { await page.close(); return; }
    else if (action !== 'inspect') { await page.getByRole('button', { name: action, exact: true }).click(); await page.waitForTimeout(500); }
    console.log((await page.locator('body').innerText()).slice(0, 14000));
    await page.screenshot({ path: path.join(config.profile, `ui-${action}.png`) });
    console.log(JSON.stringify(await page.locator('input,textarea,button,select,[role=switch]').evaluateAll(nodes => nodes.map(n => ({ tag: n.tagName, id: n.id, role: n.getAttribute('role'), name: n.getAttribute('aria-label'), text: n.innerText?.slice(0, 70) })))));
  } catch (e) { console.log((await page.locator('body').innerText()).slice(0, 10000)); throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
