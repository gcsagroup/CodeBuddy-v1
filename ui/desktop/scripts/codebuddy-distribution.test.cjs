const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { TYPE, parse } = require('@formatjs/icu-messageformat-parser');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

test('Windows Vite packages include the hoisted PTY runtime and native prebuild', async (t) => {
  const os = require('node:os');
  const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'win-pty-package-'));
  assert.equal(path.dirname(fs.realpathSync(buildPath)), fs.realpathSync(os.tmpdir()));
  t.after(() => fs.rmSync(buildPath, { recursive: true, force: true }));
  const config = require('../forge.config.ts');
  await config.hooks.packageAfterCopy({}, buildPath, '41.1.0', 'win32', 'x64');
  const sourceRoot = path.dirname(require.resolve('node-pty/package.json'));
  const stagedRoot = path.join(buildPath, 'node_modules', 'node-pty');
  for (const file of ['package.json', 'lib/index.js', 'prebuilds/win32-x64/conpty.node']) {
    assert.deepEqual(fs.readFileSync(path.join(stagedRoot, file)), fs.readFileSync(path.join(sourceRoot, file)));
  }
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readDesktopFile(relativePath) {
  return fs.readFileSync(path.join(desktopRoot, relativePath), 'utf8');
}

test('desktop package identity matches the CodeBuddy distribution metadata', () => {
  const distro = readJson(path.join(desktopRoot, 'codebuddy.distro.json'));
  const packageJson = readJson(path.join(desktopRoot, 'package.json'));

  assert.equal(distro.productName, 'CodeBuddy');
  assert.equal(distro.packageName, 'codebuddy-desktop');
  assert.equal(distro.executableName, 'CodeBuddy');
  assert.equal(distro.protocol, 'codebuddy');
  assert.equal(distro.backendProfileDirectoryName, 'backend');
  assert.equal(distro.updatesEnabled, true);
  assert.equal(distro.telemetryUiEnabled, false);

  assert.equal(packageJson.name, distro.packageName);
  assert.equal(packageJson.productName, distro.productName);
  assert.equal(packageJson.description, distro.description);
});

test('production dependency policy pins patched security versions', () => {
  const packageJson = readJson(path.join(desktopRoot, 'package.json'));
  const sdkPackage = readJson(path.join(repoRoot, 'ui', 'sdk', 'package.json'));
  const workspaceConfig = fs.readFileSync(path.join(repoRoot, 'ui', 'pnpm-workspace.yaml'), 'utf8');

  assert.equal(packageJson.dependencies['shell-quote'], '^1.10.0');
  assert.equal(packageJson.dependencies.lodash, '^4.18.1');
  assert.equal(packageJson.dependencies['react-router-dom'], '7.15.1');
  assert.equal(packageJson.dependencies.uuid, '^13.0.1');
  assert.equal(packageJson.devDependencies.electron, '41.1.0');
  assert.equal(packageJson.devDependencies.postcss, '^8.5.10');
  assert.equal(packageJson.devDependencies.vite, '^7.3.5');
  assert.equal(sdkPackage.devDependencies['@hey-api/openapi-ts'], '^0.97.3');

  const requiredOverrides = {
    'shell-quote': '1.10.0',
    'fast-uri': '3.1.4',
    hono: '4.12.27',
    'js-yaml@>=4.0.0': '4.3.0',
    lodash: '4.18.1',
    'path-to-regexp': '8.4.0',
    'react-router': '7.15.1',
    ws: '8.21.0',
    tar: '7.5.21',
    '@hono/node-server': '2.0.11',
    'ip-address': '10.1.1',
    qs: '6.15.2',
    uuid: '13.0.1',
    'yaml@<2': '1.10.3',
    'yaml@>=2': '2.8.3',
    'body-parser': '2.3.0',
    '@xmldom/xmldom@0.8': '0.8.13',
    'brace-expansion@1': '1.1.16',
    'brace-expansion@2': '2.1.2',
    'brace-expansion@5': '5.0.7',
    'defu@6': '6.1.5',
    'flatted@3': '3.4.2',
    'js-yaml@3': '3.15.0',
    'picomatch@2': '2.3.2',
    'picomatch@4': '4.0.4',
    'external-editor@3>tmp': '0.2.7',
    'tmp-promise@3>tmp': '0.2.7',
    'undici@7': '7.28.0',
    'smol-toml@1': '1.6.1',
  };

  for (const [dependency, version] of Object.entries(requiredOverrides)) {
    const escapedDependency = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      workspaceConfig,
      new RegExp(`^\\s{2}['"]?${escapedDependency}['"]?:\\s+['"]?${version}['"]?\\s*$`, 'm'),
      `${dependency} must be overridden to ${version}`
    );
  }
});

test('Windows packaging validates the cached Electron x64 artifact without fetching checksums', () => {
  const { spawnSync } = require('node:child_process');
  const packageJson = readJson(path.join(desktopRoot, 'package.json'));
  const forgeConfigPath = path.join(desktopRoot, 'forge.config.ts');
  const artifactName = `electron-v${packageJson.devDependencies.electron}-win32-x64.zip`;
  const readDownloadConfig = (platform, arch) => {
    const script = `const config = require(${JSON.stringify(
      forgeConfigPath
    )}); process.stdout.write(JSON.stringify(config.packagerConfig.download ?? null));`;
    const result = spawnSync(
      process.execPath,
      ['-e', script, '--', '--platform', platform, '--arch', arch],
      {
        encoding: 'utf8',
        shell: false,
      }
    );

    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  assert.deepEqual(readDownloadConfig('win32', 'x64'), {
    checksums: {
      [artifactName]: 'bbb798d1817bc173a187c1de30432247e48046f737fa13ade126fe3788303b81',
    },
  });
  assert.equal(readDownloadConfig('win32', 'arm64'), null);
  assert.equal(readDownloadConfig('darwin', 'x64'), null);
});

test('the workspace SDK build does not require a separately installed npm command', () => {
  const sdkPackage = readJson(path.join(repoRoot, 'ui', 'sdk', 'package.json'));

  assert.equal(sdkPackage.scripts.build, 'pnpm run generate && pnpm run build:ts');
});

test('desktop sources consume the CodeBuddy distribution metadata', () => {
  const forgeConfig = readDesktopFile('forge.config.ts');
  const updatesConfig = readDesktopFile(path.join('src', 'updates.ts'));
  const githubUpdater = readDesktopFile(path.join('src', 'update', 'githubRelease.ts'));
  const indexHtml = readDesktopFile('index.html');

  assert.match(forgeConfig, /require\(['"]\.\/codebuddy\.distro\.json['"]\)/);
  assert.match(forgeConfig, /schemes:\s*\[distro\.protocol\]/);
  assert.match(forgeConfig, /name:\s*['"]@electron-forge\/maker-squirrel['"]/);
  assert.equal(require('../forge.config.ts').makers.find(m => m.name === '@electron-forge/maker-squirrel').config.setupExe, 'CodeBuddy-Setup.exe');
  assert.match(forgeConfig, /setupIcon:\s*resolve\(__dirname,\s*['"]src\/images\/icon\.ico['"]\)/);
  assert.match(updatesConfig, /codebuddy\.distro\.json/);
  assert.match(updatesConfig, /UPDATES_ENABLED\s*=\s*distro\.updatesEnabled/);
  assert.match(updatesConfig, /TELEMETRY_UI_ENABLED\s*=\s*distro\.telemetryUiEnabled/);
  assert.doesNotMatch(githubUpdater, /aaif-goose/);
  assert.match(githubUpdater, /erjinyi-bool\/CodeBuddy-v1/);
  assert.match(indexHtml, /<title>CodeBuddy<\/title>/);

  const mainProcess = readDesktopFile(path.join('src', 'main.ts'));
  assert.match(mainProcess, /app\.setName\(distro\.productName\)/);
  assert.match(mainProcess, /CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION/);
  assert.match(mainProcess, /CODEBUDDY_USER_DATA_DIR/);
  assert.match(mainProcess, /app\.setPath\(['"]userData['"],\s*isolatedUserDataDir\)/);
  assert.match(
    mainProcess,
    /protocolRegistrationEnabled[\s\S]*app\.setAsDefaultProtocolClient\(distro\.protocol\)/
  );
  assert.match(mainProcess, /resolveCodeBuddyPaths/);
  assert.match(mainProcess, /CODEBUDDY_HOME:\s*storagePaths\.homeDir/);
  assert.doesNotMatch(
    mainProcess,
    /path\.join\(\s*app\.getPath\(['"]userData['"]\),\s*distro\.backendProfileDirectoryName\s*\)/
  );
});

test('first-run onboarding cannot enable telemetry when the distribution disables it', () => {
  const onboardingSuccess = readDesktopFile(
    path.join('src', 'components', 'onboarding', 'OnboardingSuccess.tsx')
  );

  assert.match(onboardingSuccess, /import\s*{\s*TELEMETRY_UI_ENABLED\s*}/);
  assert.match(onboardingSuccess, /useState\(false\)/);
  assert.match(onboardingSuccess, /TELEMETRY_UI_ENABLED\s*&&\s*telemetryOptIn/);
  assert.match(onboardingSuccess, /{TELEMETRY_UI_ENABLED\s*&&\s*\(/);

  assert.equal(readJson(path.join(desktopRoot, 'codebuddy.distro.json')).telemetryUiEnabled, false);
  assert.match(readDesktopFile('src/updates.ts'), /TELEMETRY_UI_ENABLED\s*=\s*distro\.telemetryUiEnabled/);
});

test('a fresh Harness profile has no bundled endpoint or forced model selection', async t => {
  const { temporaryRoot } = require('./test-helpers/harness-fixtures.cjs');
  const { pathToFileURL } = require('node:url');
  const { openStore } = await import(pathToFileURL(path.join(repoRoot, 'runtime/store.mjs')));
  const store = await openStore(temporaryRoot(t));
  assert.deepEqual(store.read(['defaults', 'providers']), {
    defaults: { providerId: null, modelId: null }, providers: [],
  });
  await store.flush();
});

test('onboarding connects a user-supplied endpoint without a bundled recommendation', () => {
  const providerSelector = readDesktopFile(
    path.join('src', 'components', 'onboarding', 'ProviderSelector.tsx')
  );

  assert.doesNotMatch(providerSelector, /RECOMMENDED_PROVIDER/);
  assert.match(providerSelector, /<CustomProviderForm/);
  assert.match(providerSelector, /compactSetup/);
  assert.match(providerSelector, /discoverModels=\{acpDiscoverCustomProviderModels\}/);
  assert.match(providerSelector, /onConfigured\(result\.provider_name, data\.models\[0\]\)/);
});

test('all locale catalogs keep the FormatJS message descriptor shape', () => {
  const messagesDir = path.join(desktopRoot, 'src', 'i18n', 'messages');
  const localeFiles = fs.readdirSync(messagesDir).filter((file) => file.endsWith('.json'));

  assert.ok(localeFiles.length > 1);
  for (const localeFile of localeFiles) {
    const messages = readJson(path.join(messagesDir, localeFile));
    for (const [messageId, descriptor] of Object.entries(messages)) {
      assert.equal(
        typeof descriptor?.defaultMessage,
        'string',
        `${localeFile}:${messageId} must contain a string defaultMessage`
      );
    }
  }
});

test('CodeBuddy starts in Simplified Chinese and keeps an in-app language switch', () => {
  const settingsSource = readDesktopFile(path.join('src', 'utils', 'settings.ts'));
  const appSettingsSource = readDesktopFile(
    path.join('src', 'components', 'settings', 'app', 'AppSettingsSection.tsx')
  );

  assert.match(settingsSource, /language:\s*['"]zh-CN['"]/);
  assert.match(appSettingsSource, /useState<LanguageSetting>\(defaultSettings\.language\)/);
  assert.match(appSettingsSource, /setSetting\(['"]language['"],\s*nextLanguage\)/);
  assert.match(appSettingsSource, /reloadApp\(\)/);
});

function untranslatedLiteralText(message) {
  const literals = [];
  function collect(elements) {
    for (const element of elements) {
      if (element.type === TYPE.literal) {
        literals.push(element.value);
      } else if (element.type === TYPE.select || element.type === TYPE.plural) {
        for (const option of Object.values(element.options)) collect(option.value);
      } else if (element.type === TYPE.tag) {
        collect(element.children);
      }
    }
  }
  collect(parse(message));
  return literals.join(' ');
}

test('locale copy detection ignores ICU argument names and format metadata', () => {
  assert.equal(untranslatedLiteralText('{title} · {status}'), ' · ');
  assert.equal(untranslatedLiteralText('{count, number} / {when, date, short}'), ' / ');
  assert.equal(untranslatedLiteralText('{state, select, ready {{title}} other {{status}}}'), '');
});

test('locale copy detection preserves visible text in ICU branches and rich text', () => {
  assert.equal(untranslatedLiteralText('Open {title}'), 'Open ');
  assert.equal(untranslatedLiteralText('<strong>Open</strong>'), 'Open');
  assert.equal(
    untranslatedLiteralText('{count, plural, one {One item} other {# items}}'),
    'One item  items'
  );
  assert.equal(untranslatedLiteralText("'{title}'"), '{title}');
  assert.throws(() => untranslatedLiteralText('{broken'));
});

test('the Simplified Chinese catalog has no untranslated English UI copy', () => {
  const zhCN = readJson(path.join(desktopRoot, 'src', 'i18n', 'messages', 'zh-CN.json'));
  const technicalOnlyMessageIds = new Set([
    'codeProModels.visionDefaultModel',
    'codeProModels.visionDefaultProvider',
    'customProviderForm.apiUrlPlaceholder',
    'customProviderForm.modelsPlaceholder',
    'codeProGit.operationCherryPick',
    'codeProGit.operationRebase',
    'codeProGit.operationRevert',
    'defaultProviderSetupForm.apiHostPlaceholder',
    'defaultProviderSetupForm.modelsPlaceholder',
    'extensionInfoFields.typeHttp',
    'extensionInfoFields.typeStdio',
    'platformExtension.computer.name',
    'huggingFaceSignInPrompt.title',
    'scheduleModal.yaml',
    'sessionViewComponents.role.assistant',
    'sessions.importNostr.placeholder',
  ]);

  const untranslated = Object.entries(zhCN)
    .filter(([messageId, descriptor]) => {
      const message = untranslatedLiteralText(descriptor.defaultMessage);
      return (
        !technicalOnlyMessageIds.has(messageId) &&
        /[A-Za-z]{2}/.test(message) &&
        !/\p{Script=Han}/u.test(message)
      );
    })
    .map(([messageId, descriptor]) => `${messageId}: ${descriptor.defaultMessage}`);

  assert.deepEqual(untranslated, []);
  assert.equal(zhCN['platformExtension.computer.name'].defaultMessage, 'Computer Use');
});

test('the Simplified Chinese catalog contains no question-mark encoding damage', () => {
  const zhCN = readJson(path.join(desktopRoot, 'src', 'i18n', 'messages', 'zh-CN.json'));
  const damaged = Object.entries(zhCN)
    .filter(([, descriptor]) => /\?{2,}/.test(descriptor.defaultMessage))
    .map(([messageId, descriptor]) => `${messageId}: ${descriptor.defaultMessage}`);

  assert.deepEqual(damaged, []);
});

test('renderer JSX has no hard-coded English UI labels outside technical values', () => {
  const allowedTechnicalValues = new Set([
    'CodeBuddy',
    'GitHub',
    'https://example.com',
    'CodeBuddy',
    'Aa',
    'MB',
    'null',
    'http://127.0.0.1:3000',
    'https://example.com',
  ]);
  const userFacingAttributes = new Set(['alt', 'aria-label', 'placeholder', 'title']);
  const violations = [];

  function visitSourceFile(filePath) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    function record(node, kind, value) {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (
        /[A-Za-z]{2}/.test(normalized) &&
        !/\p{Script=Han}/u.test(normalized) &&
        !allowedTechnicalValues.has(normalized)
      ) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const relativePath = path.relative(desktopRoot, filePath).replaceAll('\\', '/');
        violations.push(`${relativePath}:${line} (${kind}) ${normalized}`);
      }
    }

    function visit(node) {
      if (ts.isJsxText(node)) {
        record(node, 'text', node.text);
      }
      if (
        ts.isJsxAttribute(node) &&
        userFacingAttributes.has(node.name.getText(sourceFile)) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        record(node, node.name.getText(sourceFile), node.initializer.text);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  function visitDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(entryPath);
      } else if (entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name)) {
        visitSourceFile(entryPath);
      }
    }
  }

  visitDirectory(path.join(desktopRoot, 'src'));
  assert.deepEqual(violations, []);
});

test('CodePro renderer keeps Chinese protocol markers out of the display layer', () => {
  const codeProDirectory = path.join(desktopRoot, 'src', 'components', 'codepro');
  const allowedProtocolLiterals = new Set([
    '--- CodePro 任务快照 ---',
    '活动ID：',
    '状态：失败',
    '执行失败',
    '检查失败',
    '状态：成功',
    '已取消',
    '已停止',
    '命令执行完成',
    '已读取文件',
    '已查看项目结构',
    '已完成分析动作',
    '任务规划完成',
    '详情',
    '工具',
    '路径',
    '目录',
    '命令',
    '参数',
    '文件',
    '输出',
    '变更',
    '说明',
    '功能',
    '验收目标',
    '当前任务',
    '状态',
  ]);
  const violations = [];

  for (const entry of fs.readdirSync(codeProDirectory)) {
    if (!entry.endsWith('.tsx') || entry.endsWith('.test.tsx')) continue;
    const filePath = path.join(codeProDirectory, entry);
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    function visit(node) {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /\p{Script=Han}/u.test(node.text) &&
        !allowedProtocolLiterals.has(node.text)
      ) {
        violations.push(`${entry}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  assert.deepEqual(violations, []);
});

test('localized extension helpers have no executable English fallback', () => {
  const source = readDesktopFile(
    'src/components/settings/extensions/subcomponents/ExtensionList.tsx'
  );
  assert.equal((source.match(/'Built-in extension'/g) ?? []).length, 1);
  assert.doesNotMatch(source, /`\$\{label\} extension`/);
});

test('technical evidence and critical icon controls keep their accessibility contracts', () => {
  const activity = readDesktopFile('src/components/codepro/CodeProActivity.tsx');
  const taskPanel = readDesktopFile('src/components/codepro/CodeProTaskPanel.tsx');
  const technicalValue = readDesktopFile('src/components/TechnicalValue.tsx');
  const modelBar = readDesktopFile('src/components/settings/models/bottom_bar/ModelsBottomBar.tsx');
  const messageActions = readDesktopFile('src/components/MessageCopyLink.tsx');

  assert.match(activity, /<TechnicalValue\s+value=\{detail\.value\}\s+label=\{detail\.label\}/);
  assert.match(taskPanel, /<TechnicalValue[\s\S]*value=\{workspacePath\}/);
  assert.match(technicalValue, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(technicalValue, /aria-expanded=\{expanded\}/);
  assert.match(modelBar, /aria-label=\{intl\.formatMessage\(i18n\.choose\)\}[\s\S]*title=\{intl\.formatMessage\(i18n\.choose\)\}/);
  assert.match(messageActions, /aria-label=\{copyLabel\}[\s\S]*title=\{copyLabel\}/);
  assert.match(messageActions, /aria-label=\{retryLabel\}[\s\S]*title=\{retryLabel\}/);
});

test('Harness Windows build verifies the staged runtime before packaging and stops on verification failure', async t => {
  const { windowsBuild } = require('./test-helpers/harness-fixtures.cjs');
  const fixture = windowsBuild(t);
  await fixture.run();
  const runs = fixture.calls.filter(call => call.kind === 'run');
  assert.match(runs[0].args[0], /typescript[\\/]bin[\\/]tsc$/);
  assert.match(runs[1].args[0], /i18n-compile\.js$/);
  assert.match(runs[2].args[0], /verify-harness-stage\.mjs$/);
  assert.equal(runs[2].executable, path.join(fixture.stage, 'node/node.exe'));
  assert.equal(runs[3].args[1], 'make');
  assert.equal(runs[3].options.env.CODEBUDDY_HARNESS_RESOURCE_DIR, fixture.stage);
  const failed = windowsBuild(t, { failStep: args => args[0].endsWith('verify-harness-stage.mjs') });
  await assert.rejects(failed.run(), /Build step exited 1/);
  assert.ok(!failed.calls.some(call => call.args?.includes('make')));
});

test('Harness continuation requires the exact x64 package and matching runtime manifest', async t => {
  const { windowsBuild } = require('./test-helpers/harness-fixtures.cjs');
  const fixture = windowsBuild(t, { args: ['--make-only'] });
  fixture.packaged('out/old/CodeBuddy-win32-x64');
  fixture.packaged('out/CodeBuddy-win32-arm64');
  await assert.rejects(fixture.run(), /ENOENT/);
  const packaged = fixture.packaged();
  fs.writeFileSync(path.join(packaged, 'resources/harness-distribution/manifest.json'), '{}');
  await assert.rejects(fixture.run(), /matching this Harness stage/);
  fixture.packaged();
  await fixture.run();
  const make = fixture.calls.find(call => call.args?.includes('make'));
  assert.ok(make.args.includes('--platform=win32') && make.args.includes('--arch=x64'));
  assert.ok(make.args.includes('--skip-package'));
});

test('Harness Squirrel finalization verifies the exact x64 archive before invoking the packager', async t => {
  const { temporaryRoot } = require('./test-helpers/harness-fixtures.cjs');
  const { finalizeInstaller } = require(path.join(repoRoot, 'scripts/windows-installer-tools.cjs'));
  const root = temporaryRoot(t);
  // Reuse installed dependency resolution, but keep every fixture and output in temp.
  const desktop = path.join(root, 'desktop');
  fs.mkdirSync(desktop);
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.symlinkSync(path.join(repoRoot, 'ui/node_modules'), path.join(desktop, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const exact = path.join(desktop, 'out/make/squirrel.windows/x64');
  for (const relative of ['out/make/old/squirrel.windows/x64', 'out/make/squirrel.windows/ia32']) {
    fs.mkdirSync(path.join(desktop, relative), { recursive: true });
    fs.writeFileSync(path.join(desktop, relative, 'CodeBuddyHarness.1.0.0.nupkg'), 'decoy');
  }
  const packagedResources = path.join(desktop, 'out/CodeBuddy-win32-x64/resources');
  fs.mkdirSync(path.join(packagedResources, 'harness-distribution'), { recursive: true });
  fs.writeFileSync(path.join(packagedResources, 'harness-distribution/manifest.json'), '{}');
  fs.writeFileSync(path.join(packagedResources, 'app.asar'), 'fixture');
  const options = { desktop, vendor: path.join(root, 'unused-vendor') };
  await assert.rejects(finalizeInstaller(options), error => error.code === 'ENOENT' && error.path.startsWith(exact));
  fs.mkdirSync(exact, { recursive: true });
  fs.writeFileSync(path.join(exact, 'CodeBuddyHarness.1.0.0.nupkg'), 'invalid archive');
  await assert.rejects(finalizeInstaller(options), /signature|zip|buffer|file/i);
  assert.ok(!fs.existsSync(options.vendor), 'no installer process was started');
  fs.writeFileSync(path.join(exact, 'CodeBuddy-Setup.exe'), 'keep existing installer');
  await assert.rejects(finalizeInstaller(options), /Installer already exists/);
  assert.equal(fs.readFileSync(path.join(exact, 'CodeBuddy-Setup.exe'), 'utf8'), 'keep existing installer');
});

test('legacy Squirrel maker and legacy smoke scripts retain their distribution install ID', () => {
  const makerName = require('../forge.config.ts').makers.find(m => m.name === '@electron-forge/maker-squirrel').config.name;
  assert.equal(makerName, 'CodeBuddy');

  for (const scriptName of [
    'test-codebuddy-windows-installer.ps1',
    'test-codebuddy-windows-lifecycle.ps1',
    'test-codebuddy-windows-packaged-runtime.ps1',
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, 'scripts', scriptName), 'utf8');
    const installId = source.match(/\$distributionInstallId\s*=\s*["']([^"']+)["']/)?.[1];
    assert.equal(installId, makerName, `${scriptName} install ID must match Electron Forge`);
  }
});

test('Harness stage has a separate install identity and rejects modified resources', t => {
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'harness-stage-'));
  const configPath = require.resolve('../forge.config.ts');
  const previous = process.env.CODEBUDDY_HARNESS_RESOURCE_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEBUDDY_HARNESS_RESOURCE_DIR;
    else process.env.CODEBUDDY_HARNESS_RESOURCE_DIR = previous;
    delete require.cache[configPath];
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'entry.mjs'), 'fixture');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, engine: 'deepseek-harness', files: [{ path: 'entry.mjs', sha256: crypto.createHash('sha256').update('fixture').digest('hex') }] }));
  process.env.CODEBUDDY_HARNESS_RESOURCE_DIR = root;
  delete require.cache[configPath];
  const config = require(configPath);
  const maker = config.makers.find(m => m.name === '@electron-forge/maker-squirrel');
  assert.equal(maker.config.name, 'CodeBuddyHarness');
  assert.equal(maker.config.setupExe, 'CodeBuddy-Setup.exe');
  assert.equal(config.packagerConfig.name, 'CodeBuddy');
  assert.ok(config.packagerConfig.extraResource.includes(root));
  fs.writeFileSync(path.join(root, 'entry.mjs'), 'modified');
  delete require.cache[configPath];
  assert.throws(() => require(configPath), /identity mismatch/);
});

test('the Windows installer smoke test is explicit, bounded, and disposable-account-only', () => {
  const smokeScriptPath = path.join(repoRoot, 'scripts', 'test-codebuddy-windows-installer.ps1');

  assert.ok(fs.existsSync(smokeScriptPath), 'the installer smoke script must exist');
  const smokeScript = fs.readFileSync(smokeScriptPath, 'utf8');

  assert.match(smokeScript, /\[switch\]\$InstallUninstall/);
  assert.match(smokeScript, /CodeBuddy-Setup\.exe/);
  assert.match(smokeScript, /Get-FileHash[\s\S]*SHA256/);
  assert.match(smokeScript, /resources[\s\S]*goose\.exe/);
  assert.match(smokeScript, /WaitForExit\(\$TimeoutSeconds\s*\*\s*1000\)/);
  assert.match(smokeScript, /--uninstall/);
  assert.match(smokeScript, /\[switch\]\$ConfirmDisposableWindowsAccount/);
  assert.match(smokeScript, /ExpectedDisposableWindowsAccountSid/);
  assert.match(smokeScript, /CodexSandboxOffline/);
  assert.match(smokeScript, /CodexSandboxOnline/);
  assert.match(smokeScript, /Test-DisposableWindowsIdentity/);
  assert.match(smokeScript, /WindowsIdentity\]::GetCurrent\(\)/);
  assert.match(smokeScript, /currentIdentity\.User\.Value/);
  assert.match(smokeScript, /\[switch\]\$PreflightOnly/);
  assert.match(smokeScript, /if \(-not \$ConfirmDisposableWindowsAccount\)/);
  assert.match(smokeScript, /CODEBUDDY_DISPOSABLE_TEST_ACCOUNT\s+-ne\s+["']true["']/);
  assert.match(smokeScript, /Assert-NoInstallerEnvironmentOverrides/);
  assert.match(smokeScript, /Assert-NoProtectedFootprint/);
  assert.match(smokeScript, /SpecialFolder\]::LocalApplicationData/);
  assert.match(smokeScript, /SpecialFolder\]::ApplicationData/);
  assert.match(smokeScript, /existing protected footprint/);
  assert.doesNotMatch(smokeScript, /CodeBuddy-Smoke(?:UserData)?(?:Backup|Leftovers)-/);
  assert.doesNotMatch(smokeScript, /Move-Item/);
  assert.doesNotMatch(smokeScript, /Remove-Item[^\r\n]*-Recurse/);
  assert.match(smokeScript, /CODEBUDDY_HOME/);
  assert.match(smokeScript, /GOOSE_PATH_ROOT/);
  assert.match(smokeScript, /CODEBUDDY_MIGRATE_LEGACY/);
  assert.match(smokeScript, /CODEBUDDY_USER_DATA_DIR/);
  assert.match(smokeScript, /Uninstall/);
  assert.match(smokeScript, /HKCU:\\Software\\Classes\\codebuddy/);
  assert.match(smokeScript, /StartMenu/);
  assert.match(smokeScript, /DesktopDirectory/);
  assert.match(smokeScript, /Update\.exe[\s\S]*packages[\s\S]*app-\*/);
  assert.match(smokeScript, /Get-UninstallRegistrationKeys/);
  assert.match(smokeScript, /Get-ProductShortcutPaths/);

  const liveInstallerInvocation = smokeScript.indexOf('$installResult =');
  assert.ok(liveInstallerInvocation > 0, 'the live installer invocation must remain explicit');
  for (const guard of [
    'if (-not $ConfirmDisposableWindowsAccount)',
    'if ($env:CODEBUDDY_DISPOSABLE_TEST_ACCOUNT -ne "true")',
    '[Environment+SpecialFolder]::LocalApplicationData',
    '[Environment+SpecialFolder]::ApplicationData',
    '$existingPaths = @($protectedPaths',
    'Assert-NoInstallerEnvironmentOverrides -EnvironmentValues $environmentValues',
    'Assert-NoProtectedFootprint -ExistingPaths $existingPaths',
  ]) {
    assert.ok(
      smokeScript.indexOf(guard) < liveInstallerInvocation,
      `${guard} must fail closed before the installer can run`
    );
  }
});

test('Windows live preflight executes fail-closed without starting product executables', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell preflight contract');
    return;
  }

  const { spawnSync } = require('node:child_process');
  const currentIdentity = JSON.parse(
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[PSCustomObject]@{Name=[Security.Principal.WindowsIdentity]::GetCurrent().Name;Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8' }
    ).stdout.trim()
  );
  assert.match(currentIdentity.Sid, /^S-1-/);
  assert.ok(currentIdentity.Name, 'Preflight must identify the current Windows account');

  const scripts = [
    {
      path: path.join(repoRoot, 'scripts', 'test-codebuddy-windows-installer.ps1'),
      confirm: ['-InstallUninstall', '-ConfirmDisposableWindowsAccount'],
      required: [],
    },
    {
      path: path.join(repoRoot, 'scripts', 'test-codebuddy-windows-lifecycle.ps1'),
      confirm: ['-ConfirmIsolatedLifecycle', '-ConfirmDisposableWindowsAccount'],
      required: [
        '-CurrentInstallerPath',
        'unused-installer.exe',
        '-IsolatedRoot',
        'unused-root',
        '-EvidencePath',
        'unused-evidence.json',
      ],
    },
    {
      path: path.join(repoRoot, 'scripts', 'test-codebuddy-windows-packaged-runtime.ps1'),
      confirm: ['-ConfirmIsolatedRuntime', '-ConfirmDisposableWindowsAccount'],
      required: [
        '-PackagedAppPath',
        'unused-app.exe',
        '-IsolatedRoot',
        'unused-root',
        '-EvidencePath',
        'unused-evidence.json',
      ],
    },
  ];
  const cleanEnv = { ...process.env, CODEBUDDY_DISPOSABLE_TEST_ACCOUNT: 'true' };
  delete cleanEnv.CODEBUDDY_HOME;
  delete cleanEnv.GOOSE_PATH_ROOT;
  delete cleanEnv.CODEBUDDY_MIGRATE_LEGACY;

  function runPreflight(script, extraArgs = [], env = cleanEnv) {
    return spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        script.path,
        ...script.required,
        ...script.confirm,
        '-PreflightOnly',
        ...extraArgs,
      ],
      { encoding: 'utf8', env }
    );
  }

  for (const script of scripts) {
    const missingSid = runPreflight(script);
    assert.notEqual(missingSid.status, 0);
    assert.match(
      `${missingSid.stdout}\n${missingSid.stderr}`,
      /expected disposable Windows account SID/i
    );

    const mismatchedSid = runPreflight(script, [
      '-ExpectedDisposableWindowsAccountSid',
      'S-1-5-21-0-0-0-1001',
    ]);
    assert.notEqual(mismatchedSid.status, 0);
    assert.match(`${mismatchedSid.stdout}\n${mismatchedSid.stderr}`, /SID mismatch/i);
    assert.doesNotMatch(`${mismatchedSid.stdout}\n${mismatchedSid.stderr}`, /PACKAGE_CHECK=PASS/);

    const matchingCurrentSid = runPreflight(script, [
      '-ExpectedDisposableWindowsAccountSid',
      currentIdentity.Sid,
    ]);
    assert.notEqual(matchingCurrentSid.status, 0);
    assert.match(
      `${matchingCurrentSid.stdout}\n${matchingCurrentSid.stderr}`,
      /dedicated Windows account name/i
    );
  }
});

test('the disposable identity decision accepts only dedicated account names with matching SIDs', (t) => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell identity decision contract');
    return;
  }
  const { spawnSync } = require('node:child_process');
  for (const scriptName of [
    'test-codebuddy-windows-installer.ps1',
    'test-codebuddy-windows-lifecycle.ps1',
    'test-codebuddy-windows-packaged-runtime.ps1',
  ]) {
    const scriptPath = path.join(repoRoot, 'scripts', scriptName);
    const prefix = [
      `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
      `$functionAst=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-DisposableWindowsIdentity'},$true)`,
      'Invoke-Expression $functionAst.Extent.Text',
      `$script:allowedDisposableWindowsAccountNames=@('CodexSandboxOffline','CodexSandboxOnline')`,
    ].join(';');
    const allowed = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};Test-DisposableWindowsIdentity -IdentityName 'TESTHOST\\CodexSandboxOffline' -IdentitySid 'S-1-5-21-1-2-3-1003' -ExpectedSid 'S-1-5-21-1-2-3-1003'|Out-Null`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(allowed.status, 0, `${scriptName}: ${allowed.stderr}`);

    const ordinary = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};Test-DisposableWindowsIdentity -IdentityName 'TESTHOST\\jiangrui' -IdentitySid 'S-1-5-21-1-2-3-1001' -ExpectedSid 'S-1-5-21-1-2-3-1001'`,
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(ordinary.status, 0);
    assert.match(`${ordinary.stdout}\n${ordinary.stderr}`, /dedicated Windows account name/i);
  }
});

test('installer preflight decisions reject environment overrides and protected footprints', (t) => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell installer preflight decision contract');
    return;
  }
  const { spawnSync } = require('node:child_process');
  const scriptPath = path.join(repoRoot, 'scripts', 'test-codebuddy-windows-installer.ps1');
  const prefix = [
    `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
    `$functions=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Assert-NoInstallerEnvironmentOverrides','Assert-NoProtectedFootprint')},$true)`,
    '$functions|ForEach-Object { Invoke-Expression $_.Extent.Text }',
  ].join(';');

  const override = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${prefix};Assert-NoInstallerEnvironmentOverrides -EnvironmentValues @{CODEBUDDY_HOME='fixture-home'}`,
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(override.status, 0);
  assert.match(`${override.stdout}\n${override.stderr}`, /CODEBUDDY_HOME must be unset/i);

  const footprint = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${prefix};Assert-NoProtectedFootprint -ExistingPaths @('fixture-install') -ProtocolExists $false -UninstallKeys @() -Shortcuts @()`,
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(footprint.status, 0);
  assert.match(`${footprint.stdout}\n${footprint.stderr}`, /existing protected footprint/i);
});

test('Harness build does not run installation or legacy account lifecycle actions', async t => {
  const { windowsBuild } = require('./test-helpers/harness-fixtures.cjs');
  const fixture = windowsBuild(t, { args: ['--make-only', '--installer=inno'] });
  fixture.packaged();
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.kind === 'wizard').length, 1);
  assert.equal(fixture.calls.filter(call => call.kind === 'run').length, 1);
  assert.match(fixture.calls.find(call => call.kind === 'run').args[0], /verify-harness-stage\.mjs$/);
  const unsupported = windowsBuild(t, { args: ['--install'] });
  await assert.rejects(unsupported.run(), /Usage/);
  assert.equal(unsupported.calls.length, 0);
});

test('Windows package inspection is non-destructive and emits bounded artifact evidence', () => {
  const inspectionPath = path.join(repoRoot, 'scripts', 'inspect-codebuddy-windows-package.ps1');
  assert.ok(fs.existsSync(inspectionPath), 'the package inspection script must exist');
  const inspection = fs.readFileSync(inspectionPath, 'utf8');

  assert.match(inspection, /Get-FileHash[\s\S]*SHA256/);
  assert.match(inspection, /Get-AuthenticodeSignature/);
  assert.match(inspection, /resources[\s\S]*app\.asar/);
  assert.match(inspection, /resources[\s\S]*goose\.exe/);
  assert.match(inspection, /ConvertTo-Json/);
  assert.match(inspection, /MaxLogBytes/);
  assert.doesNotMatch(inspection, /Start-Process/);
  assert.doesNotMatch(inspection, /--uninstall/);
  assert.doesNotMatch(inspection, /Remove-Item[^\r\n]*-Recurse/);
});

test('direct Forge packaging fails without a verified Harness stage instead of accepting a legacy backend', () => {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, CODEBUDDY_BACKEND_RESOURCE_DIR: 'legacy-stage', CODEBUDDY_BACKEND_MANIFEST_PATH: 'legacy-manifest' };
  delete env.CODEBUDDY_HARNESS_RESOURCE_DIR;
  const result = spawnSync(process.execPath,
    ['-e', `process.argv.push('package');require(${JSON.stringify(path.join(desktopRoot, 'forge.config.ts'))})`],
    { encoding: 'utf8', env, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a verified Harness distribution stage/);
});

test('the explicit Windows lifecycle gate requires a disposable account and isolated data root', () => {
  const lifecyclePath = path.join(repoRoot, 'scripts', 'test-codebuddy-windows-lifecycle.ps1');
  const probePath = path.join(
    repoRoot,
    'ui',
    'desktop',
    'scripts',
    'installed-lifecycle-probe.cjs'
  );
  assert.ok(fs.existsSync(lifecyclePath), 'the lifecycle script must exist');
  assert.ok(fs.existsSync(probePath), 'the installed desktop probe must exist');
  const lifecycle = fs.readFileSync(lifecyclePath, 'utf8');
  const probe = fs.readFileSync(probePath, 'utf8');

  assert.match(lifecycle, /\[switch\]\$ConfirmIsolatedLifecycle/);
  assert.match(lifecycle, /\[switch\]\$ConfirmDisposableWindowsAccount/);
  assert.match(lifecycle, /ExpectedDisposableWindowsAccountSid/);
  assert.match(lifecycle, /CodexSandboxOffline/);
  assert.match(lifecycle, /CodexSandboxOnline/);
  assert.match(lifecycle, /Test-DisposableWindowsIdentity/);
  assert.match(lifecycle, /\[switch\]\$PreflightOnly/);
  assert.match(lifecycle, /CODEBUDDY_DISPOSABLE_TEST_ACCOUNT/);
  assert.match(lifecycle, /PreviousInstallerPath/);
  assert.match(lifecycle, /IsolatedRoot/);
  assert.match(lifecycle, /EvidencePath/);
  assert.match(lifecycle, /target[\\/]codebuddy-lifecycle/);
  assert.match(lifecycle, /target[\\/]codebuddy-lifecycle-evidence/);
  assert.match(lifecycle, /Split-Path -Parent \$IsolatedRoot/);
  assert.match(lifecycle, /FileAttributes\]::ReparsePoint/);
  assert.match(lifecycle, /Refusing to overwrite existing lifecycle evidence/);
  assert.match(lifecycle, /SpecialFolder\]::LocalApplicationData/);
  assert.match(lifecycle, /SpecialFolder\]::ApplicationData/);
  assert.match(lifecycle, /GOOSE_PATH_ROOT/);
  assert.match(lifecycle, /CODEBUDDY_HOME/);
  assert.match(lifecycle, /CODEBUDDY_MIGRATE_LEGACY/);
  assert.match(lifecycle, /\$originalCodeBuddyHome\s*=\s*\$env:CODEBUDDY_HOME/);
  assert.match(lifecycle, /\$env:CODEBUDDY_HOME\s*=\s*\$backendProfile/);
  assert.match(lifecycle, /\$env:CODEBUDDY_MIGRATE_LEGACY\s*=\s*["']0["']/);
  assert.match(lifecycle, /\$env:CODEBUDDY_HOME\s*=\s*\$originalCodeBuddyHome/);
  assert.match(lifecycle, /lifecycle-sentinel\.json/);
  assert.match(lifecycle, /--uninstall/);
  assert.match(lifecycle, /Stop-Process[\s\S]*-Force/);
  assert.match(lifecycle, /UPGRADE/);
  assert.match(lifecycle, /REINSTALL_PREVIOUS/);
  assert.match(lifecycle, /\[version\]::TryParse/);
  assert.doesNotMatch(lifecycle, /Sort-Object FullName -Descending/);
  assert.match(lifecycle, /Update\.exe[\s\S]*packages[\s\S]*app-\*/);
  assert.match(lifecycle, /Assert-ProtectedHostPathsAbsent/);
  assert.match(lifecycle, /PROTECTED_HOST_PATHS_ABSENT/);
  assert.match(lifecycle, /ConvertTo-Json/);
  assert.doesNotMatch(lifecycle, /CodeBuddy-SmokeBackup-/);
  assert.doesNotMatch(lifecycle, /\$env:LOCALAPPDATA\s*=/);
  assert.doesNotMatch(lifecycle, /\$env:APPDATA\s*=/);

  assert.match(probe, /connectOverCDP/);
  assert.match(probe, /listRecentDirs/);
  assert.match(probe, /GOOSE_WORKING_DIR/);
  assert.match(probe, /readFile/);
  assert.match(probe, /SAFE_LOCAL_TASK/);
});

test('the packaged runtime gate cannot replace the installed protocol handler', () => {
  const runtimePath = path.join(
    repoRoot,
    'scripts',
    'test-codebuddy-windows-packaged-runtime.ps1'
  );
  assert.ok(fs.existsSync(runtimePath), 'the packaged runtime script must exist');
  const runtime = fs.readFileSync(runtimePath, 'utf8');

  assert.match(runtime, /\[switch\]\$ConfirmIsolatedRuntime/);
  assert.match(runtime, /\[switch\]\$ConfirmDisposableWindowsAccount/);
  assert.match(runtime, /ExpectedDisposableWindowsAccountSid/);
  assert.match(runtime, /CodexSandboxOffline/);
  assert.match(runtime, /CodexSandboxOnline/);
  assert.match(runtime, /Test-DisposableWindowsIdentity/);
  assert.match(runtime, /\[switch\]\$PreflightOnly/);
  assert.match(runtime, /target[\\/]codebuddy-packaged-runtime/);
  assert.match(runtime, /target[\\/]codebuddy-lifecycle-evidence/);
  assert.match(runtime, /Split-Path -Parent \$IsolatedRoot/);
  assert.match(runtime, /FileAttributes\]::ReparsePoint/);
  assert.match(runtime, /Refusing to overwrite existing packaged runtime evidence/);
  assert.match(
    runtime,
    /Refusing packaged runtime testing while packaged processes are already running/
  );
  assert.match(runtime, /CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION/);
  assert.match(runtime, /CODEBUDDY_USER_DATA_DIR/);
  assert.match(runtime, /CODEBUDDY_HOME/);
  assert.match(runtime, /CODEBUDDY_MIGRATE_LEGACY/);
  assert.match(runtime, /CODEBUDDY_HOME\s*=\s*\$env:CODEBUDDY_HOME/);
  assert.match(runtime, /\$env:CODEBUDDY_HOME\s*=\s*\$backendProfile/);
  assert.match(runtime, /\$env:CODEBUDDY_MIGRATE_LEGACY\s*=\s*["']0["']/);
  assert.match(runtime, /Get-DirectoryFingerprint/);
  assert.match(runtime, /Get-ProtocolCommand/);
  assert.match(runtime, /Get-RegistryTreeFingerprint/);
  assert.match(runtime, /Get-UninstallFingerprint/);
  assert.match(runtime, /Get-ShortcutFingerprint/);
  assert.match(runtime, /PROTOCOL_HANDLER_UNCHANGED/);
  assert.match(runtime, /REAL_USER_DATA_UNCHANGED/);
  assert.match(runtime, /installed-lifecycle-probe\.cjs/);
  assert.match(runtime, /Stop-Process[\s\S]*-Force/);
  assert.match(runtime, /ConvertTo-Json/);
});

test('the installer and lifecycle executable selectors order semantic versions numerically', (t) => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell lifecycle selector contract');
    return;
  }

  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  for (const scriptName of [
    'test-codebuddy-windows-installer.ps1',
    'test-codebuddy-windows-lifecycle.ps1',
  ]) {
    const scriptPath = path.join(repoRoot, 'scripts', scriptName);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-version-selector-'));
    try {
      for (const version of ['1.9.0', '1.10.0']) {
        const appDir = path.join(root, `app-${version}`);
        fs.mkdirSync(appDir);
        fs.writeFileSync(path.join(appDir, 'CodeBuddy.exe'), 'fixture');
      }
      const command = [
        `$tokens = $null; $errors = $null; $ast = [Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)`,
        `$functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstalledExecutable' }, $true)`,
        'Invoke-Expression $functionAst.Extent.Text',
        `$script:installRoot = '${root.replaceAll("'", "''")}'`,
        'Get-InstalledExecutable',
      ].join('; ');
      const selected = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8' }
      );
      assert.equal(selected.status, 0, `${scriptName}: ${selected.stderr}`);
      assert.match(selected.stdout.trim(), /app-1\.10\.0[\\/]CodeBuddy\.exe$/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('desktop shutdown waits for its Harness owner and bounds an unresponsive service', async t => {
  const { harnessService } = require('./test-helpers/harness-fixtures.cjs');
  const fixture = harnessService(t);
  fixture.announce();
  const service = await fixture.ready;
  let closed = false;
  const close = service.close();
  assert.equal(service.close(), close, 'shutdown is idempotent');
  close.then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'wait for the service to release its Harness and MCP owners');
  assert.equal(fixture.calls.filter(call => call.kind === 'send' && call.message.type === 'shutdown').length, 1);
  const timer = [...fixture.timers.values()].find(timer => timer.delay === 15000);
  assert.ok(timer, 'shutdown has a bounded fallback');
  timer.fn();
  await close;
  assert.equal(fixture.calls.filter(call => call.kind === 'kill').length, 1);
  assert.equal(fixture.unexpected(), 0);
  const main = readDesktopFile('src/main.ts');
  const shutdown = main.slice(main.indexOf('let harnessQuitFinished = false;'), main.indexOf("app.on('will-quit'"));
  let beforeQuit;
  let quitCalls = 0;
  let prevented = 0;
  let finishDraft;
  let finishHarness;
  require('node:vm').runInNewContext(shutdown, {
    app: {
      on: (name, callback) => { assert.equal(name, 'before-quit'); beforeQuit = callback; },
      quit: () => { quitCalls++; beforeQuit({ preventDefault: () => prevented++ }); },
    },
    draftStore: { flush: () => new Promise(resolve => { finishDraft = resolve; }) },
    packagedHarnessService: { close: () => new Promise(resolve => { finishHarness = resolve; }) },
  });
  beforeQuit({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  finishHarness();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCalls, 0, 'also wait for pending drafts before quitting');
  finishDraft();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCalls, 1);
  assert.equal(prevented, 1, 'the final quit must not start shutdown again');
});

test('main window is revealed only after the React renderer reports ready', () => {
  const mainProcess = readDesktopFile('src/main.ts');
  const createChatStart = mainProcess.indexOf('const createChat = async');
  const createLauncherStart = mainProcess.indexOf('const createLauncher =', createChatStart);
  const createChat = mainProcess.slice(createChatStart, createLauncherStart);
  const reactReadyStart = mainProcess.indexOf("ipcMain.on('react-ready'");
  const openExternalStart = mainProcess.indexOf("ipcMain.handle('open-external'", reactReadyStart);
  const reactReady = mainProcess.slice(reactReadyStart, openExternalStart);

  assert.ok(createChatStart >= 0 && createLauncherStart > createChatStart);
  assert.ok(reactReadyStart >= 0 && openExternalStart > reactReadyStart);
  assert.doesNotMatch(createChat, /ready-to-show[\s\S]*mainWindow\.show\(\)/);
  assert.match(reactReady, /window\.show\(\)/);
  assert.match(reactReady, /window\.webContents\.invalidate\(\)/);
});
