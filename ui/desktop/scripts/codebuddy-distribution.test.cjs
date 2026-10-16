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
  assert.equal(distro.updatesEnabled, false);
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
  const githubUpdater = readDesktopFile(path.join('src', 'utils', 'githubUpdater.ts'));
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
  assert.match(githubUpdater, /if\s*\(!this\.owner\s*\|\|\s*!this\.repo\)/);
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

  const mainProcess = readDesktopFile(path.join('src', 'main.ts'));
  assert.match(mainProcess, /GOOSE_TELEMETRY_OFF:\s*['"]1['"]/);
});

test('the bundled Ollama Cloud provider exposes only the authorized default model', () => {
  const provider = readJson(
    path.join(
      repoRoot,
      'crates',
      'goose-providers',
      'src',
      'declarative',
      'definitions',
      'ollama_cloud.json'
    )
  );

  assert.equal(provider.name, 'ollama_cloud');
  assert.equal(provider.engine, 'openai');
  assert.equal(provider.api_key_env, 'OLLAMA_CLOUD_API_KEY');
  assert.equal(provider.base_url, 'https://ollama.com/v1/chat/completions');
  assert.equal(provider.dynamic_models, true);
  assert.equal(provider.supports_streaming, true);
  assert.deepEqual(provider.models, [{ name: 'glm-5.2', context_limit: 1000000 }]);
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
  assert.match(modelBar, /aria-label=\{modelTriggerLabel\}[\s\S]*title=\{modelTriggerLabel\}/);
  assert.match(messageActions, /aria-label=\{copyLabel\}[\s\S]*title=\{copyLabel\}/);
  assert.match(messageActions, /aria-label=\{retryLabel\}[\s\S]*title=\{retryLabel\}/);
});

test('the Windows build script enforces the CodeBuddy quality gates', () => {
  const buildScript = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'build-codebuddy-windows.ps1'),
    'utf8'
  );

  assert.match(buildScript, /vswhere\.exe/);
  assert.match(buildScript, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/);
  assert.match(buildScript, /VsDevCmd\.bat/);
  assert.match(buildScript, /-arch=x64\s+-host_arch=x64/);
  assert.match(buildScript, /LIBCLANG_PATH/);
  assert.match(buildScript, /function\s+Ensure-V8BuildJunction/);
  assert.match(buildScript, /cargo\s+metadata\s+--format-version\s+1/);
  assert.match(buildScript, /New-Item\s+-ItemType\s+Junction/);
  assert.match(
    buildScript,
    /Ensure-V8BuildJunction\s+-Profile\s+["']debug["'][\s\S]*cargo\s+clippy/
  );
  assert.match(
    buildScript,
    /Ensure-V8BuildJunction\s+-Profile\s+["']release["'][\s\S]*cargo\s+build\s+--release/
  );
  assert.match(buildScript, /Require-Command\s+["']cmake["']/);
  assert.match(buildScript, /Import-VisualStudioBuildEnvironment[\s\S]*cargo\s+fmt/);
  assert.match(buildScript, /cargo\s+fmt\s+--all\s+--\s+--check/);
  assert.match(
    buildScript,
    /cargo\s+clippy\s+--workspace\s+--all-targets\s+--exclude\s+v8\s+--jobs\s+\$CheckJobs\s+--\s+-D\s+warnings/
  );
  for (const parameter of ['CheckJobs', 'BuildJobs']) {
    assert.match(
      buildScript,
      new RegExp(`\\[ValidateRange\\(1,\\s*16\\)\\]\\[int\\]\\$${parameter}\\s*=\\s*1\\s*,`)
    );
  }
  assert.doesNotMatch(buildScript, /cargo\s+clippy[^\r\n]*--all-features/);
  assert.match(
    buildScript,
    /if\s*\(-not\s+\$SkipTests\)\s*\{[\s\S]*\$env:CARGO_PROFILE_TEST_DEBUG\s*=\s*["']0["'][\s\S]*\$env:CARGO_INCREMENTAL\s*=\s*["']0["'][\s\S]*cargo\s+test\s+-p\s+goose-providers\s+declarative[\s\S]*cargo\s+test\s+--workspace\s+--jobs\s+1/
  );
  assert.match(buildScript, /test:distribution/);
  assert.match(buildScript, /typecheck/);
  assert.match(buildScript, /lint:check/);
  assert.match(
    buildScript,
    /node\s+\.\\scripts\\prepare-platform-binaries\.js[\s\S]*electron-forge\s+package/
  );
  assert.match(buildScript, /function\s+Copy-AppLocalVisualCppRuntime/);
  assert.match(buildScript, /VCToolsRedistDir/);
  assert.match(buildScript, /protectedProcessEnvironmentNames[\s\S]*PSModulePath/);
  assert.match(
    buildScript,
    /Import-Module\s+Microsoft\.PowerShell\.Security\s+-ErrorAction\s+Stop/
  );
  assert.match(buildScript, /Microsoft\.VC\*\.CRT/);
  assert.match(buildScript, /MSVCP140\.dll/);
  assert.match(buildScript, /VCRUNTIME140\.dll/);
  assert.match(buildScript, /VCRUNTIME140_1\.dll/);
  assert.match(
    buildScript,
    /Copy-AppLocalVisualCppRuntime\s+-Destination\s+\$packagingBin[\s\S]*prepare-platform-binaries\.js/
  );
  assert.match(buildScript, /CodeBuddy-win32/);
  assert.match(buildScript, /CodeBuddy-Setup\.exe/);
  assert.match(buildScript, /\[switch\]\$UseExistingReleaseBackend/);
  assert.match(buildScript, /target\\codebuddy-package/);
  assert.match(buildScript, /Refusing to reset a reparse-point packaging stage/);
  assert.match(buildScript, /CODEBUDDY_BACKEND_RESOURCE_DIR/);
  assert.match(buildScript, /\[switch\]\$RunInstallerSmoke/);
  assert.match(buildScript, /\[string\]\$PreviousInstallerPath/);
  assert.match(buildScript, /\[string\]\$ExpectedDisposableWindowsAccountSid/);
  assert.match(buildScript, /inspect-codebuddy-windows-package\.ps1/);
  assert.match(buildScript, /test-codebuddy-windows-installer\.ps1/);
  assert.match(buildScript, /test-codebuddy-windows-lifecycle\.ps1/);
  assert.match(buildScript, /target\\codebuddy-lifecycle/);
  assert.match(buildScript, /ConfirmIsolatedLifecycle/);
  assert.match(buildScript, /ConfirmDisposableWindowsAccount/);
  assert.match(buildScript, /Get-DisposableIdentityArguments/);
  assert.match(buildScript, /\$installerSmokeArguments\s*\+=\s*\$disposableIdentityArguments/);
  assert.match(buildScript, /\$lifecycleArguments\s*\+=\s*\$disposableIdentityArguments/);
  assert.doesNotMatch(buildScript, /OLLAMA_CLOUD_API_KEY\s*=/);
});

test('the Windows build selects only the exact win32 x64 package output', (t) => {
  const buildPath = path.join(repoRoot, 'scripts', 'build-codebuddy-windows.ps1');
  const buildScript = fs.readFileSync(buildPath, 'utf8');

  assert.match(buildScript, /\$packagePlatform\s*=\s*["']win32["']/);
  assert.match(buildScript, /\$packageArchitecture\s*=\s*["']x64["']/);
  assert.match(
    buildScript,
    /electron-forge\s+package\s+--platform\s+\$packagePlatform\s+--arch\s+\$packageArchitecture/
  );
  assert.match(
    buildScript,
    /electron-forge\s+make\s+--platform\s+\$packagePlatform\s+--arch\s+\$packageArchitecture/
  );
  assert.match(buildScript, /function\s+Get-ExactPackagedExecutable/);
  assert.match(buildScript, /Test-Path\s+-LiteralPath\s+\$packageDirectory/);
  assert.match(buildScript, /Get-Item\s+-LiteralPath\s+\$packageDirectory/);
  assert.match(buildScript, /FileAttributes\]::ReparsePoint/);
  assert.doesNotMatch(
    buildScript,
    /Get-ChildItem[^\r\n]*CodeBuddy\.exe[^\r\n]*-Recurse[\s\S]*?Select-Object\s+-First\s+1/
  );

  if (process.platform !== 'win32') {
    t.skip('PowerShell exact package selection contract');
    return;
  }

  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-package-selector-'));
  const exactDirectory = path.join(root, 'out', 'CodeBuddy-win32-x64');
  const failedDirectory = path.join(root, 'out', 'failed-old', 'CodeBuddy-win32-x64');
  fs.mkdirSync(exactDirectory, { recursive: true });
  fs.mkdirSync(failedDirectory, { recursive: true });
  fs.writeFileSync(path.join(exactDirectory, 'CodeBuddy.exe'), 'current');
  fs.writeFileSync(path.join(failedDirectory, 'CodeBuddy.exe'), 'failed-old');

  try {
    const prefix = [
      `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${buildPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
      `$functionAst=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ExactPackagedExecutable'},$true)`,
      'Invoke-Expression $functionAst.Extent.Text',
    ].join(';');
    const selected = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};(Get-ExactPackagedExecutable -DesktopRoot '${root.replaceAll("'", "''")}' -Platform 'win32' -Architecture 'x64').FullName`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(
      path.normalize(selected.stdout.trim()),
      path.join(exactDirectory, 'CodeBuddy.exe')
    );

    fs.rmSync(exactDirectory, { recursive: true, force: true });
    const failedOnly = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};Get-ExactPackagedExecutable -DesktopRoot '${root.replaceAll("'", "''")}' -Platform 'win32' -Architecture 'x64'`,
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(failedOnly.status, 0);
    assert.match(`${failedOnly.stdout}\n${failedOnly.stderr}`, /exact packaged application/i);
    assert.doesNotMatch(
      `${failedOnly.stdout}\n${failedOnly.stderr}`,
      /failed-old[\\/]CodeBuddy\.exe/i
    );

    const reparseTarget = path.join(root, 'reparse-target');
    fs.mkdirSync(reparseTarget);
    fs.writeFileSync(path.join(reparseTarget, 'CodeBuddy.exe'), 'reparse-target');
    fs.symlinkSync(reparseTarget, exactDirectory, 'junction');
    const reparseDirectory = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};Get-ExactPackagedExecutable -DesktopRoot '${root.replaceAll("'", "''")}' -Platform 'win32' -Architecture 'x64'`,
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(reparseDirectory.status, 0);
    assert.match(`${reparseDirectory.stdout}\n${reparseDirectory.stderr}`, /reparse-point/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Windows build selects only the exact x64 Squirrel installer', (t) => {
  const buildPath = path.join(repoRoot, 'scripts', 'build-codebuddy-windows.ps1');
  const buildScript = fs.readFileSync(buildPath, 'utf8');

  assert.match(buildScript, /function\s+Get-ExactSquirrelInstaller/);
  assert.match(
    buildScript,
    /out[\\/]make[\\/]squirrel\.windows[\\/]x64[\\/]CodeBuddy-Setup\.exe/
  );
  assert.match(buildScript, /Test-Path\s+-LiteralPath\s+\$installerPath/);
  assert.match(buildScript, /Get-Item\s+-LiteralPath\s+\$installerPath/);
  assert.doesNotMatch(
    buildScript,
    /Get-ChildItem[^\r\n]*CodeBuddy-Setup\.exe[^\r\n]*-Recurse[\s\S]*?Select-Object\s+-First\s+1/
  );

  if (process.platform !== 'win32') {
    t.skip('PowerShell exact installer selection contract');
    return;
  }

  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-installer-selector-'));
  const exactDirectory = path.join(root, 'out', 'make', 'squirrel.windows', 'x64');
  const exactInstaller = path.join(exactDirectory, 'CodeBuddy-Setup.exe');
  const failedInstaller = path.join(
    root,
    'out',
    'make',
    'failed-old',
    'squirrel.windows',
    'x64',
    'CodeBuddy-Setup.exe'
  );
  const otherArchitectureInstaller = path.join(
    root,
    'out',
    'make',
    'squirrel.windows',
    'ia32',
    'CodeBuddy-Setup.exe'
  );
  fs.mkdirSync(exactDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(failedInstaller), { recursive: true });
  fs.mkdirSync(path.dirname(otherArchitectureInstaller), { recursive: true });
  fs.writeFileSync(exactInstaller, 'current');
  fs.writeFileSync(failedInstaller, 'failed-old');
  fs.writeFileSync(otherArchitectureInstaller, 'other-architecture');

  try {
    const prefix = [
      `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${buildPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
      `$functionAst=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ExactSquirrelInstaller'},$true)`,
      'Invoke-Expression $functionAst.Extent.Text',
    ].join(';');
    const selected = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};(Get-ExactSquirrelInstaller -DesktopRoot '${root.replaceAll("'", "''")}' -Platform 'win32' -Architecture 'x64').FullName`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(path.normalize(selected.stdout.trim()), exactInstaller);

    fs.rmSync(exactDirectory, { recursive: true, force: true });
    const decoysOnly = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};Get-ExactSquirrelInstaller -DesktopRoot '${root.replaceAll("'", "''")}' -Platform 'win32' -Architecture 'x64'`,
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(decoysOnly.status, 0);
    assert.match(`${decoysOnly.stdout}\n${decoysOnly.stderr}`, /exact Squirrel installer/i);
    assert.doesNotMatch(
      `${decoysOnly.stdout}\n${decoysOnly.stderr}`,
      /(?:failed-old|ia32)[\\/]CodeBuddy-Setup\.exe/i
    );

    const reparseTarget = path.join(root, 'installer-reparse-target');
    fs.mkdirSync(reparseTarget);
    fs.writeFileSync(path.join(reparseTarget, 'CodeBuddy-Setup.exe'), 'reparse-target');
    fs.symlinkSync(reparseTarget, exactDirectory, 'junction');
    const reparseParent = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix};Get-ExactSquirrelInstaller -DesktopRoot '${root.replaceAll("'", "''")}' -Platform 'win32' -Architecture 'x64'`,
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(reparseParent.status, 0);
    assert.match(`${reparseParent.stdout}\n${reparseParent.stderr}`, /reparse-point/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.match(currentIdentity.Name, /jiangrui$/i);

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

test('the Windows build forwards the disposable SID to installer and lifecycle calls', (t) => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell build argument contract');
    return;
  }
  const { spawnSync } = require('node:child_process');
  const buildPath = path.join(repoRoot, 'scripts', 'build-codebuddy-windows.ps1');
  const command = [
    `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${buildPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
    `$functionAst=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-DisposableIdentityArguments'},$true)`,
    'Invoke-Expression $functionAst.Extent.Text',
    `Get-DisposableIdentityArguments -ExpectedSid 'S-1-5-21-1-2-3-1003'`,
  ].join(';');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    '-ConfirmDisposableWindowsAccount',
    '-ExpectedDisposableWindowsAccountSid',
    'S-1-5-21-1-2-3-1003',
  ]);
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

test('Windows packaging rejects debug CRT backends and binds the package to target release', (t) => {
  const { spawnSync } = require('node:child_process');
  const peGatePath = path.join(repoRoot, 'scripts', 'codebuddy-windows-pe.ps1');
  const buildPath = path.join(repoRoot, 'scripts', 'build-codebuddy-windows.ps1');
  const inspectionPath = path.join(repoRoot, 'scripts', 'inspect-codebuddy-windows-package.ps1');
  const forgePath = path.join(desktopRoot, 'forge.config.ts');

  assert.ok(fs.existsSync(peGatePath), 'the shared PE release gate must exist');
  const peGate = fs.readFileSync(peGatePath, 'utf8');
  const build = fs.readFileSync(buildPath, 'utf8');
  const inspection = fs.readFileSync(inspectionPath, 'utf8');
  const forge = fs.readFileSync(forgePath, 'utf8');

  assert.match(peGate, /VCRUNTIME\.\*D/i);
  assert.match(peGate, /MSVCP\.\*D/i);
  assert.match(peGate, /ucrtbased/i);
  assert.match(peGate, /dumpbin(?:\.exe)?/i);
  assert.match(peGate, /\/DEPENDENTS/);
  assert.match(peGate, /Assert-CodeBuddyReleaseBackend/);
  assert.match(build, /codebuddy-windows-pe\.ps1/);
  assert.match(build, /\.\s+\$peInspectionScript/);
  assert.match(
    build,
    /Assert-CodeBuddyReleaseBackend[\s\S]*-BackendPath\s+\$backendSource[\s\S]*-ExpectedReleaseBackendPath\s+\$backendSource/
  );
  assert.match(build, /-UseExistingBackend[^\r\n]*(?:disabled|removed|unsupported)/i);
  assert.match(build, /Write-PackagingBackendManifest/);
  assert.match(build, /CODEBUDDY_BACKEND_MANIFEST_PATH/);
  assert.match(
    build,
    /\$packagingBin\s*=\s*Use-PackagingBackendStage[\s\S]*Sync-PackagingBackendStage/
  );
  assert.match(inspection, /ExpectedReleaseBackendPath/);
  assert.match(
    inspection,
    /Assert-CodeBuddyReleaseBackend[\s\S]*-BackendPath\s+\$backendMatches\[0\]\.FullName[\s\S]*-ExpectedReleaseBackendPath\s+\$ExpectedReleaseBackendPath/
  );
  assert.match(forge, /isWindowsDistribution/);
  assert.match(forge, /CODEBUDDY_BACKEND_MANIFEST_PATH/);
  assert.match(forge, /target['"],\s*['"]codebuddy-package/);
  assert.match(forge, /manifest\.profile\s*!==\s*['"]release['"]/);
  assert.match(forge, /manifest\.backendSha256\s*!==\s*stagedBackendSha256/);

  if (process.platform !== 'win32') {
    t.skip('PowerShell PE dependency gate');
    return;
  }

  const directForgeEnv = { ...process.env };
  delete directForgeEnv.CODEBUDDY_BACKEND_RESOURCE_DIR;
  delete directForgeEnv.CODEBUDDY_BACKEND_MANIFEST_PATH;
  const directForge = spawnSync(
    process.execPath,
    ['-e', `process.argv.push('package');require(${JSON.stringify(forgePath)})`],
    { encoding: 'utf8', env: directForgeEnv }
  );
  assert.notEqual(directForge.status, 0);
  assert.match(
    `${directForge.stdout}\n${directForge.stderr}`,
    /requires the verified Release backend stage/i
  );

  const commandPrefix = `. '${peGatePath.replaceAll("'", "''")}'`;
  const releaseFixture = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${commandPrefix};Assert-CodeBuddyDependencySet -DependencyNames @('KERNEL32.dll','VCRUNTIME140.dll','MSVCP140.dll','ucrtbase.dll') | Out-Null`,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(releaseFixture.status, 0, releaseFixture.stderr);

  const debugFixture = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${commandPrefix};Assert-CodeBuddyDependencySet -DependencyNames @('KERNEL32.dll','VCRUNTIME140D.dll','ucrtbased.dll') | Out-Null`,
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(debugFixture.status, 0);
  assert.match(`${debugFixture.stdout}\n${debugFixture.stderr}`, /Debug CRT/i);
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

test('storage migration cancellation stops the child tree before desktop exit', () => {
  const mainProcess = readDesktopFile('src/main.ts');
  const migration = readDesktopFile('src/storage/storageMigration.ts');

  assert.match(mainProcess, /progressWindow\.on\('closed', cancelMigration\)/);
  assert.match(mainProcess, /app\.on\('before-quit', cancelMigrationForQuit\)/);
  assert.match(mainProcess, /event\.preventDefault\(\)/);
  assert.match(mainProcess, /signal: migrationController\.signal/);
  assert.match(mainProcess, /if \(quitAfterMigrationCancel\)[\s\S]*app\.exit\(0\)/);
  assert.match(migration, /taskkill\.exe/);
  assert.match(migration, /\['\/PID', String\(pid\), '\/T', '\/F'\]/);
  assert.match(migration, /terminate\('timed_out'\)/);
  assert.match(migration, /terminate\('cancelled'\)/);
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
