const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('root pnpm scripts delegate to the existing UI workspace', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(manifest.private, true);
  assert.match(manifest.scripts['install:ui'], /--dir ui install --frozen-lockfile/);
  assert.equal(manifest.scripts['prestart-gui'], 'pnpm run install:ui');
  assert.match(manifest.scripts['start-gui'], /--dir ui\/desktop run start-gui$/);
  assert.equal(manifest.scripts['prestart-gui-debug'], 'pnpm run install:ui');
  assert.match(
    manifest.scripts['start-gui-debug'],
    /--dir ui\/desktop run start-gui-debug$/
  );
});

test('the UI workspace pins the pnpm version used by Corepack', () => {
  const root = path.resolve(__dirname, '..');
  const uiManifest = JSON.parse(
    fs.readFileSync(path.join(root, 'ui', 'package.json'), 'utf8')
  );

  assert.equal(uiManifest.packageManager, 'pnpm@11.9.0');
});
