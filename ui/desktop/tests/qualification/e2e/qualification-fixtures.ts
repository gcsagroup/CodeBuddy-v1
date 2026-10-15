import { expect, test as isolatedTest } from '../../e2e/fixtures';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Qualification must be credential-free and reproducible. The isolated profile starts the
// repository's local OpenAI-compatible test server and cannot read the developer's real profile.
export const test = isolatedTest.extend({
  profileMode: 'isolated',
  initialWorkingDir: async ({}, use, testInfo) => {
    const isL1 = testInfo.title.startsWith('L1 ');
    const isL3 = testInfo.title.startsWith('L3 ');
    const isP0Repair = testInfo.title.startsWith('P0 ');
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'codepro-qualification-'));
    const workspace = join(temporaryRoot, 'UserProject');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(join(workspace, 'tests'), { recursive: true });
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify(
        {
          name: 'codepro-qualification',
          type: isP0Repair ? 'commonjs' : 'module',
          scripts: { test: isP0Repair ? 'node tests.js' : 'node --test' },
        },
        null,
        2
      ),
      'utf8'
    );
    writeFileSync(join(workspace, 'src', 'button.js'), "export const label = 'old';\n", 'utf8');
    writeFileSync(
      join(workspace, 'tests', 'button.test.mjs'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { label } from '../src/button.js';",
        `test('button label', () => assert.equal(label, '${isL1 ? 'new' : 'old'}'));`,
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(workspace, 'src', 'controller.js'),
      "export function greeting() { return 'old'; }\n",
      'utf8'
    );
    writeFileSync(
      join(workspace, 'src', 'route.js'),
      "import { greeting } from './controller.js';\nexport function handle() { return greeting(); }\n",
      'utf8'
    );
    writeFileSync(
      join(workspace, 'src', 'access.js'),
      'export const adminAccess = false;\n',
      'utf8'
    );
    writeFileSync(
      join(workspace, 'tests', 'access.test.mjs'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { adminAccess } from '../src/access.js';",
        `test('admin access', () => assert.equal(adminAccess, ${isL3 ? 'true' : 'false'}));`,
        '',
      ].join('\n'),
      'utf8'
    );
    if (isP0Repair) {
      mkdirSync(join(workspace, '.codepro'), { recursive: true });
      writeFileSync(
        join(workspace, 'implementation.js'),
        'exports.add = function add(a, b) {\n  return a - b;\n};\n',
        'utf8'
      );
      writeFileSync(
        join(workspace, 'tests.js'),
        [
          "const { add } = require('./implementation.js');",
          'if (add(2, 2) !== 4) {',
          "  console.error('FAIL add_returns_four: expected 4, got ' + add(2, 2));",
          '  process.exit(1);',
          '}',
          "console.log('PASS add_returns_four');",
          '',
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        join(workspace, '.codepro', 'test-config.yml'),
        'test_cmd: node tests.js\n',
        'utf8'
      );
    }
    try {
      await use(workspace);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
});

export { expect };
