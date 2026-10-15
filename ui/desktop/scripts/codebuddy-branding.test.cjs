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

test('CodePro unified mode hides the workspace switcher while preserving titlebar clearance and rollback support', () => {
  const appLayout = readDesktopSource('src/components/Layout/AppLayout.tsx');
  const navigationPanel = readDesktopSource('src/components/Layout/NavigationPanel.tsx');
  const unifiedMode = readDesktopSource('src/codepro/unifiedMode.ts');
  const app = readDesktopSource('src/App.tsx');
  const sessions = readDesktopSource('src/acp/sessions.ts');

  assert.doesNotMatch(appLayout, /left-1\/2 top-\[10px\]/);
  assert.match(navigationPanel, /data-testid="navigation-header-slot"/);
  assert.match(navigationPanel, /needsTrafficLightInset && 'pt-8'/);
  assert.match(navigationPanel, /flex h-10 items-center/);
  assert.match(navigationPanel, /\{!unifiedMode && \(/);
  assert.match(navigationPanel, /<WorkspaceSwitcher/);
  assert.match(navigationPanel, /unifiedMode=\{codeProUnifiedMode\}/);
  assert.match(unifiedMode, /value !== false/);
  assert.match(unifiedMode, /'\/': '\/codepro'/);
  assert.match(app, /import Hub from '.\/components\/Hub'/);
  assert.match(app, /path="pair"/);
  assert.match(sessions, /'code' \| 'codepro' \| 'unified'/);
  assert.match(sessions, /\['user', 'scheduled'\]/);
  assert.match(sessions, /\['code_pro'\]/);
});

test('local TLS backend uses the loopback readiness probe before fingerprint pinning', () => {
  const main = readDesktopSource('src/main.ts');
  const localBackendStart = main.slice(
    main.indexOf('gooseServeResult = await startGooseServe({'),
    main.indexOf('if (!gooseServeResult.certFingerprint)')
  );

  assert.doesNotMatch(localBackendStart, /readinessFetch:\s*net\.fetch/);
  assert.match(main, /localCertificateTrust\.trust\.fingerprint = localCertFingerprint/);
});
