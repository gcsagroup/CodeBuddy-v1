const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stageInstallerTools, assertSquirrelRuntimePaths } = require('./windows-installer-tools.cjs');

test('rejects the reproduced Office install path before Squirrel and accepts the relocated payload', () => {
  const installRoot = 'C:\\Users\\jiangrui\\AppData\\Local\\CodeBuddyHarness\\app-1.43.3-harness15';
  const suffix = 'dependencies/python/Lib/site-packages/lxml/isoschematron/resources/xsl/iso-schematron-xslt1/iso_schematron_skeleton_for_xslt1.xsl';
  assert.throws(() => assertSquirrelRuntimePaths([{ path: `runtime/office-assets/primary-runtime/${suffix}` }], installRoot), /exceeds legacy Windows limits/);
  assert.ok(assertSquirrelRuntimePaths([{ path: `runtime/py/${suffix}` }], installRoot) < 260);
  assert.throws(() => assertSquirrelRuntimePaths([{ path: `runtime/${'a'.repeat(240)}/x` }], installRoot), /exceeds legacy Windows limits/);
});

test('stages the installed architecture-specific tools under names required by Squirrel without changing dependencies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-winstaller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  for (const file of ['Squirrel.exe', 'nuget.exe', '7z-x64.exe', '7z-x64.dll']) fs.writeFileSync(path.join(source, file), file);
  const target = stageInstallerTools(source, path.join(root, 'stage'), 'x64');
  assert.equal(fs.readFileSync(path.join(target, '7z.exe'), 'utf8'), '7z-x64.exe');
  assert.equal(fs.readFileSync(path.join(target, '7z.dll'), 'utf8'), '7z-x64.dll');
  assert.equal(fs.existsSync(path.join(source, '7z.exe')), false);
  assert.throws(() => stageInstallerTools(source, path.join(root, 'missing'), 'arm64'), /Missing installed packaging tool/);
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});
