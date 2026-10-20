const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const qualificationRoots = ['v1', 'v2'].map((version) => ({
  version: `codebuddy-ollama-cloud-${version}`,
  root: path.join(repoRoot, 'evals', 'codebuddy', `ollama-cloud-${version}`),
}));
const normalizedTextExtensions = new Set(['.json', '.md', '.py', '.txt', '.yaml', '.yml']);

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function hashDirectory(directory) {
  const files = [];

  function visit(currentDirectory) {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else {
        files.push(entryPath);
      }
    }
  }

  visit(directory);
  files.sort((a, b) => a.localeCompare(b));

  const hash = crypto.createHash('sha256');
  for (const filePath of files) {
    const relativePath = path.relative(directory, filePath).replaceAll('\\', '/');
    const rawContent = fs.readFileSync(filePath);
    const content = normalizedTextExtensions.has(path.extname(filePath).toLowerCase())
      ? Buffer.from(rawContent.toString('utf8').replaceAll('\r\n', '\n'))
      : rawContent;
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('Ollama Cloud G0/G1 qualification thresholds are frozen before execution', () => {
  for (const qualification of qualificationRoots) {
    const manifest = readJson(qualification.root, 'qualification.json');

    assert.equal(manifest.qualificationVersion, qualification.version);
    assert.equal(manifest.gates.g0.repetitions, 3);
    assert.equal(manifest.gates.g0.timeoutSeconds, 120);
    assert.equal(manifest.gates.g0.requireExactJson, true);
    assert.deepEqual(manifest.gates.g0.expected, { status: 'ok', sum: 42 });

    assert.equal(manifest.gates.g1.repetitions, 3);
    assert.equal(manifest.gates.g1.timeoutSeconds, 180);
    assert.equal(manifest.gates.g1.expectedFile, 'src/pricing.py');
    assert.equal(manifest.gates.g1.expectedLine, 3);
    assert.equal(manifest.gates.g1.requireZeroFilesystemChanges, true);
    assert.equal(manifest.gates.g1.maxConsecutiveIdenticalToolCalls, 2);
  }
});

test('the G1 fixture is deterministic and contains the documented defect', () => {
  for (const qualification of qualificationRoots) {
    const manifest = readJson(qualification.root, 'qualification.json');
    const fixtureRoot = path.join(qualification.root, manifest.gates.g1.fixtureDirectory);
    const source = fs.readFileSync(path.join(fixtureRoot, 'src', 'pricing.py'), 'utf8');
    const sourceLines = source.split(/\r?\n/);
    const fixtureHash = hashDirectory(fixtureRoot);

    assert.equal(fixtureHash, manifest.gates.g1.fixtureSha256);
    assert.match(sourceLines[manifest.gates.g1.expectedLine - 1], /return subtotal - shipping/);
    assert.match(
      fs.readFileSync(path.join(fixtureRoot, 'tests', 'test_pricing.py'), 'utf8'),
      /assert total\(10, 3\) == 13/
    );
  }
});

test('qualification prompts prohibit secrets and primary-repository writes', () => {
  for (const qualification of qualificationRoots) {
    const g0Prompt = fs.readFileSync(path.join(qualification.root, 'prompts', 'g0.txt'), 'utf8');
    const g1Prompt = fs.readFileSync(path.join(qualification.root, 'prompts', 'g1.txt'), 'utf8');

    assert.match(g0Prompt, /只输出一个 JSON 对象/);
    assert.match(g1Prompt, /只读/);
    assert.match(g1Prompt, /不得修改/);
    assert.doesNotMatch(`${g0Prompt}\n${g1Prompt}`, /API[_ -]?KEY|Bearer\s+/i);
  }

  const v2Prompt = fs.readFileSync(
    path.join(qualificationRoots[1].root, 'prompts', 'g1.txt'),
    'utf8'
  );
  assert.match(v2Prompt, /显示真实行号/);
});

test('the live qualification runner is credential-safe and fixture-scoped', () => {
  const runner = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'test-ollama-cloud-qualification.ps1'),
    'utf8'
  );

  assert.match(runner, /GOOSE_KEYRING_SERVICE/);
  assert.match(runner, /GOOSE_KEYRING_LEGACY_SERVICE/);
  assert.match(runner, /fixtureDirectory/);
  assert.match(runner, /Get-Random|Guid/);
  assert.match(runner, /git status --porcelain/);
  assert.match(runner, /ConvertFrom-Json/);
  assert.match(runner, /maxConsecutiveIdenticalToolCalls/);
  assert.match(runner, /Get-NormalizedFixtureContent/);
  assert.match(runner, /cmdkey\.exe[\s\S]*\/list/);
  assert.match(runner, /secrets\.codebuddy/);
  assert.match(runner, /secrets\.goose/);
  assert.match(runner, /credentialMigration/);
  assert.match(runner, /@\(\$toolCalls\)\.Count/);
  assert.match(runner, /@\(\$g0Attempts\)\.Count/);
  assert.match(runner, /@\(\$g1Attempts\)\.Count/);
  assert.doesNotMatch(runner, /cmdkey\.exe[\s\S]*\/(?:add|delete)/i);
  assert.doesNotMatch(runner, /\[string\]\s*\$ApiKey|param\s*\([^)]*ApiKey/is);
  assert.doesNotMatch(runner, /Write-(?:Host|Output)[^\r\n]*(?:password|secret|api.?key)/i);
});

test('the live qualification runner isolates the child process environment', () => {
  const runner = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'test-ollama-cloud-qualification.ps1'),
    'utf8'
  );
  const allowlistMatch = runner.match(
    /\$inheritedEnvironmentAllowlist\s*=\s*@\(([\s\S]*?)\r?\n\s*\)/
  );

  assert.match(
    runner,
    /\$startInfo\.EnvironmentVariables\.Clear\(\)[\s\S]*\$inheritedEnvironmentAllowlist/
  );
  assert.ok(allowlistMatch, 'expected an explicit inherited environment allowlist');

  const inheritedNames = [...allowlistMatch[1].matchAll(/'([^']+)'/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(inheritedNames, [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
  ]);
  assert.equal(inheritedNames.some((name) => /(?:key|token|secret)/i.test(name)), false);
  assert.match(
    runner,
    /GetEnvironmentVariable\(\$name,\s*\[EnvironmentVariableTarget\]::Process\)/
  );
  assert.doesNotMatch(runner, /(?:OLLAMA|GOOSE_PROVIDER)__?API_?KEY\s*=/i);
});

test('recorded qualification results are auditable and contain no credentials', () => {
  let resultCount = 0;

  for (const qualification of qualificationRoots) {
    const resultsDirectory = path.join(qualification.root, 'results');
    if (!fs.existsSync(resultsDirectory)) continue;

    for (const file of fs.readdirSync(resultsDirectory).filter((name) => name.endsWith('.json'))) {
      resultCount += 1;
      const raw = fs.readFileSync(path.join(resultsDirectory, file), 'utf8');
      const result = JSON.parse(raw);

      assert.equal(result.qualificationVersion, qualification.version);
      assert.equal(result.provider, 'ollama_cloud');
      assert.match(result.model, /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/);
      assert.match(result.binarySha256, /^[a-f0-9]{64}$/);
      assert.match(result.fixtureSha256, /^[a-f0-9]{64}$/);
      assert.equal(result.g0.attempts.length, 3);
      assert.equal(result.g1.attempts.length, 3);
      assert.match(result.g0.status, /^(?:PASS|FAIL)$/);
      assert.match(result.g1.status, /^(?:PASS|FAIL)$/);
      assert.doesNotMatch(raw, /Bearer\s+[A-Za-z0-9._-]+/i);
      assert.doesNotMatch(raw, /(?:API[_-]?KEY|password|secret)\s*[=:]\s*["'][^"']+/i);
    }
  }

  assert.ok(resultCount >= 2, 'expected the two v1 candidate records');
});

test('Harness completion qualification preserves failure and separates task completion from verification evidence', () => {
  // Execute the current owner contract; do not resurrect the removed Rust
  // Coordinator suite or infer acceptance from old compiler report files.
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
    'runtime/tests/harness-authority-acp.test.mjs'], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const contract of ['ordinary Harness answer completes', 'transport failure preserves actual failure',
    'native tool receipts remain factual', 'historical verification receipts do not certify later native work']) {
    assert.ok(result.stdout.includes('ok ') && result.stdout.includes(contract), contract);
  }
  assert.match(result.stdout, /# fail 0/);
  assert.match(result.stdout, /# skipped 0/);
});
