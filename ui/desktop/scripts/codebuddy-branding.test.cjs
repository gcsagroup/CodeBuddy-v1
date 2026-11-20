const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');

function readDesktopSource(relativePath) {
  return fs.readFileSync(path.join(desktopRoot, relativePath), 'utf8');
}

test('active desktop visuals do not render legacy goose artwork', () => {
  const activeVisualSources = [
    'src/components/LoadingGoose.tsx',
    'src/components/McpApps/McpAppRenderer.tsx',
    'src/components/recipes/CreateEditRecipeModal.tsx',
  ].map(readDesktopSource);

  for (const source of activeVisualSources) {
    assert.doesNotMatch(source, /<FlyingBird\b|<Geese\b/);
  }
});

test('user-facing desktop components do not link to the legacy Goose documentation site', () => {
  const componentRoot = path.join(desktopRoot, 'src', 'components');
  const violations = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (/\.tsx?$/.test(entry.name)) {
        const source = fs.readFileSync(entryPath, 'utf8');
        if (source.includes('goose-docs.ai')) {
          violations.push(path.relative(desktopRoot, entryPath).replaceAll('\\', '/'));
        }
      }
    }
  }

  visit(componentRoot);
  assert.deepEqual(violations, []);
});

test('error and skills views expose only implemented CodeBuddy actions', () => {
  const errorBoundary = readDesktopSource('src/components/ErrorBoundary.tsx');
  const skillsView = readDesktopSource('src/components/skills/SkillsView.tsx');

  assert.doesNotMatch(errorBoundary, /Honk!/);
  assert.doesNotMatch(skillsView, /comingSoon|addSkill/);
});

test('unified navigation preserves titlebar clearance and legacy session routes without a workspace switcher', () => {
  const appLayout = readDesktopSource('src/components/Layout/AppLayout.tsx');
  const navigationPanel = readDesktopSource('src/components/Layout/NavigationPanel.tsx');
  const unifiedMode = readDesktopSource('src/codepro/unifiedMode.ts');
  const app = readDesktopSource('src/App.tsx');
  const sessions = readDesktopSource('src/acp/sessions.ts');

  assert.doesNotMatch(appLayout, /left-1\/2 top-\[10px\]/);
  assert.match(navigationPanel, /data-testid="navigation-header-slot"/);
  assert.match(navigationPanel, /needsTrafficLightInset && 'pt-10'/);
  assert.match(navigationPanel, /flex h-10 min-w-0 items-center/);
  assert.doesNotMatch(navigationPanel, /<WorkspaceSwitcher/);
  assert.match(unifiedMode, /'\/': '\/codepro'/);
  assert.match(app, /<Route index element=\{<CodeProHub \/>\}/);
  assert.match(app, /path="pair"/);
  assert.match(sessions, /'code' \| 'codepro' \| 'unified'/);
  assert.match(sessions, /\['user', 'scheduled'\]/);
  assert.match(sessions, /\['code_pro'\]/);
});

test('packaged Harness admits only loopback IPC readiness and supplies a fresh service secret', async t => {
  const { harnessService } = require('./test-helpers/harness-fixtures.cjs');
  const fixture = harnessService(t);
  let ready = false;
  fixture.ready.then(() => { ready = true; });
  fixture.announce('http://example.com:4567');
  fixture.announce('https://127.0.0.1:4567');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false, 'remote or TLS announcements are not the local Harness endpoint');
  fixture.announce();
  const service = await fixture.ready;
  assert.equal(service.url, 'http://127.0.0.1:4567');
  assert.match(service.secret, /^[a-f0-9]{64}$/);
  const launch = fixture.calls.find(call => call.kind === 'spawn');
  assert.equal(launch.args[2].env.CODEBUDDY_SERVER__SECRET_KEY, service.secret);
  assert.match(launch.args[1][0], /runtime[\\/]desktop-entry\.mjs$/);
  assert.ok(!fs.readFileSync(path.join(fixture.root, 'home/logs/harness/launch.json'), 'utf8').includes(service.secret));
  const closing = service.close();
  fixture.child.emit('exit', 0);
  await closing;
  assert.equal(fixture.unexpected(), 0);
});
