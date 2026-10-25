const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { stageWindowsToolRuntime } = require('./stage-harness-distribution.cjs');

test('Windows tool distribution carries its own VC runtime and upstream license; missing payload fails closed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-tool-crt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const python = path.join(runtime, 'py/dependencies/python');
  const destination = path.join(root, 'distribution');
  await fs.mkdir(python, { recursive: true });
  const dll = Buffer.from([0x4d, 0x5a, 0, 0xff, 0x31]);
  await fs.writeFile(path.join(python, 'vcruntime140.dll'), dll);
  await fs.writeFile(path.join(python, 'LICENSE.txt'), 'Upstream Windows binary terms');
  await stageWindowsToolRuntime(runtime, destination);
  assert.deepEqual(await fs.readFile(path.join(destination, 'runtime/tools/bin/vcruntime140.dll')), dll);
  assert.equal(await fs.readFile(path.join(destination, 'runtime/tools/licenses/python-windows-LICENSE.txt'), 'utf8'), 'Upstream Windows binary terms');
  await fs.unlink(path.join(python, 'vcruntime140.dll'));
  await assert.rejects(stageWindowsToolRuntime(runtime, path.join(root, 'incomplete')), { code: 'ENOENT' });
});
