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
  page.setDefaultTimeout(20000); await page.bringToFront();
  const receipt = { profile: config.profile, startedAt: new Date().toISOString(), pages: [], pageErrors: [], checks: [] };
  page.on('pageerror', e => receipt.pageErrors.push(e.message));
  const state = () => JSON.parse(fs.readFileSync(path.join(config.profile, 'backend', 'state.json')));
  const wait = async condition => { const start = Date.now(); while (!condition()) { if (Date.now() - start > 10000) throw Error('Persisted setting did not update'); await page.waitForTimeout(100); } };
  try {
    if (!(await page.getByRole('button', { name: '记忆', exact: true }).isVisible())) await page.getByRole('button', { name: '设置', exact: true }).click();
    for (const name of ['常规', '键盘快捷键', '模型与运行', '行为与回答', '输入', '记忆', '安全与权限', '工具与连接', '账号与凭据']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForTimeout(450);
      const text = await page.locator('body').innerText();
      assert.ok(!text.includes('This preview has not connected this capability'), name);
      receipt.pages.push(name);
      await page.screenshot({ path: path.join(config.profile, `settings-${name}.png`) });
    }
    await page.getByRole('button', { name: '记忆', exact: true }).click();
    const habits = page.getByRole('switch', { name: '自动记住我的使用习惯', exact: true });
    await habits.click(); await wait(() => state().preferences.personalizedMemoryEnabled === true);
    await habits.click(); await wait(() => state().preferences.personalizedMemoryEnabled === false);
    const memory = page.getByRole('switch', { name: '启用项目记忆', exact: true });
    await memory.click(); await wait(() => !state().extensions.find(e => e.configKey === 'projectmemory').enabled);
    await memory.click(); await wait(() => state().extensions.find(e => e.configKey === 'projectmemory').enabled);
    receipt.checks.push('Memory and personalization switches persisted through actual UI RPCs');
    await page.getByRole('button', { name: '行为与回答', exact: true }).click();
    const instructions = '# Acceptance fixture\nUse actual project test results when reporting completion.\n';
    await page.locator('textarea:not(#dynamic-textarea)').fill(instructions);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const instructionsPath = path.join(config.profile, 'AGENTS.md');
    await wait(() => fs.existsSync(instructionsPath) && fs.readFileSync(instructionsPath, 'utf8') === instructions);
    receipt.checks.push('Global instructions saved by existing Electron editor');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '行为与回答', exact: true }).click();
    assert.equal(await page.locator('textarea:not(#dynamic-textarea)').inputValue(), instructions);
    receipt.checks.push('Instructions retained when reopening settings');
    assert.deepEqual(receipt.pageErrors, []);
    receipt.status = 'passed';
  } catch (e) { receipt.status = 'failed'; receipt.error = e.message; process.exitCode = 1; console.log((await page.locator('body').innerText()).slice(-10000)); }
  finally { receipt.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(config.profile, 'settings-ui-receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt)); await browser.close(); }
})();
