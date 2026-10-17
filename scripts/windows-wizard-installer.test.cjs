const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildOptions, resolveCompiler, inspectApplication, stageInstallerApplication } = require('./windows-wizard-installer.cjs');

test('installer selection does not mistake a flag for the stage path or break Squirrel continuation', () => {
  assert.deepEqual(buildOptions(['--installer=inno']), { installer: 'inno', stage: undefined, makeOnly: false, finalizeOnly: false });
  assert.deepEqual(buildOptions(['C:/stage', '--make-only']), { installer: 'squirrel', stage: 'C:/stage', makeOnly: true, finalizeOnly: false });
  assert.equal(buildOptions(['--finalize-only']).installer, 'squirrel');
  assert.throws(() => buildOptions(['--installer=inno', '--finalize-only']), /only available for Squirrel/);
  assert.throws(() => buildOptions(['--installer=unknown']), /inno or squirrel/);
  assert.throws(() => buildOptions(['--install']), /Usage/);
});

test('missing compiler and translation are explicit errors, without downloading or installing tools', t => {
  assert.throws(() => resolveCompiler({}), /never installs tools automatically/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-installer-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiler = path.join(root, 'ISCC.exe');
  fs.writeFileSync(compiler, 'compiler fixture');
  assert.throws(() => resolveCompiler({ CODEBUDDY_ISCC: compiler }), /ChineseSimplified/);
  const messages = path.join(root, 'ChineseSimplified.isl');
  fs.writeFileSync(messages, 'translation fixture');
  assert.deepEqual(resolveCompiler({ CODEBUDDY_ISCC: compiler, CODEBUDDY_INNO_ZH_CN: messages }), { compiler, chineseMessages: messages });
});

function application(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-installer-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packaged = path.join(root, 'application');
  const distribution = path.join(packaged, 'resources/harness-distribution');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(distribution, { recursive: true });
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(packaged, 'CodeBuddy.exe'), 'desktop fixture');
  fs.writeFileSync(path.join(packaged, 'resources/app.asar'), 'asar fixture');
  fs.writeFileSync(path.join(distribution, 'runtime.mjs'), 'runtime fixture');
  const sha256 = crypto.createHash('sha256').update('runtime fixture').digest('hex');
  const manifest = JSON.stringify({ engine: 'deepseek-harness', schemaVersion: 1, sourceDigest: 'fixture-digest', files: [{ path: 'runtime.mjs', sha256 }] });
  for (const directory of [stage, distribution]) fs.writeFileSync(path.join(directory, 'manifest.json'), manifest);
  return { packaged, stage, distribution };
}

test('installer input binds every runtime file to the stage and measures the actual relative install paths', t => {
  const { packaged, stage } = application(t);
  const result = inspectApplication(packaged, stage);
  assert.equal(result.files, 4);
  assert.equal(result.sourceDigest, 'fixture-digest');
  assert.equal(result.longestRelativePath, 'resources/harness-distribution/manifest.json'.length);
  assert.match(result.appAsarSha256, /^[a-f0-9]{64}$/);
});

test('runtime tampering and a different staged candidate prevent installer generation', t => {
  const { packaged, stage, distribution } = application(t);
  fs.writeFileSync(path.join(distribution, 'runtime.mjs'), 'different bytes');
  assert.throws(() => inspectApplication(packaged, stage), /identity mismatch/);
  fs.writeFileSync(path.join(stage, 'manifest.json'), '{}');
  assert.throws(() => inspectApplication(packaged, stage), /does not match/);
});

test('long compiler source paths use a short copy of the same verified application', t => {
  const { packaged, stage } = application(t);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-copy-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  assert.equal(stageInstallerApplication(packaged, 20, temporary), packaged);
  const copied = stageInstallerApplication(packaged, 259 - packaged.length, temporary);
  assert.notEqual(copied, packaged);
  assert.deepEqual(inspectApplication(copied, stage), inspectApplication(packaged, stage));
  assert.equal(fs.readFileSync(path.join(copied, 'CodeBuddy.exe'), 'utf8'), 'desktop fixture');
});
