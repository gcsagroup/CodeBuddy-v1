const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'codebuddy-windows.yml');

test('GitHub Actions builds only the CodeBuddy Windows distribution', () => {
  assert.ok(fs.existsSync(workflowPath), 'missing CodeBuddy Windows workflow');

  const source = fs.readFileSync(workflowPath, 'utf8');

  assert.match(source, /^name:\s*CodeBuddy Windows/m);
  assert.match(source, /push:[\s\S]*branches:\s*\[main\]/);
  assert.match(source, /pull_request:[\s\S]*branches:\s*\[main\]/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(source, /github\.repository == 'erjinyi-bool\/CodeBuddy'/);
  assert.match(source, /build-codebuddy-windows\.ps1 -SkipDependencyInstall/);
  assert.match(source, /CodeBuddy-win32-x64/);
  assert.match(source, /CodeBuddy-Setup\.exe/);
  assert.match(source, /test-codebuddy-windows-packaged-runtime\.ps1/);
  assert.match(source, /-ConfirmIsolatedRuntime/);
  assert.match(source, /test-codebuddy-windows-lifecycle\.ps1/);
  assert.match(source, /CODEBUDDY_DISPOSABLE_TEST_ACCOUNT:\s*["']true["']/);
  assert.match(source, /-ConfirmIsolatedLifecycle/);
  assert.match(source, /-ConfirmDisposableWindowsAccount/);
  assert.match(source, /target[\\/]codebuddy-lifecycle-evidence[\\/]packaged-runtime\.json/);
  assert.match(source, /target[\\/]codebuddy-lifecycle-evidence[\\/]installed-lifecycle\.json/);
  assert.match(
    source,
    /name:\s*Upload CodeBuddy Windows lifecycle evidence[\s\S]*if:\s*always\(\)[\s\S]*target[\\/]codebuddy-lifecycle-evidence[\\/]\*\.json/
  );
  assert.match(source, /name:\s*CodeBuddy-Windows-unsigned/);
  assert.doesNotMatch(source, /secrets\./);
  assert.doesNotMatch(source, /AZURE_|signing|Goose-win32-x64/);
});
