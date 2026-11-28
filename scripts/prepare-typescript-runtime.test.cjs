const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareTypeScript } = require('./prepare-typescript-runtime.cjs');

const python = path.resolve(__dirname, '../runtime/py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const pins = require('../runtime/assets/typescript-runtime.json');

async function fixture(t, unsafe = false) {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'typescript-prepare-')));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const assets = path.join(repo, 'runtime/assets');
  await fs.mkdir(assets, { recursive: true });
  const archives = new Map(), packages = [];
  for (const item of pins.packages) {
    const entries = item.name === 'typescript-language-server' ? ['cli.mjs']
      : ['tsserver.js', '_tsserver.js', 'typescript.js', 'typingsInstaller.js', '_typingsInstaller.js'];
    const files = {
      'package/package.json': JSON.stringify({ name: item.name, version: item.version, license: item.license }),
      ['package/' + item.licenseFile]: 'Isolated fixture license placeholder',
      ...Object.fromEntries(entries.map(entry => ['package/lib/' + entry, '// isolated fixture; never executed'])),
      ...(unsafe ? { 'package/../../escaped': 'must not extract' } : {}),
    };
    const result = spawnSync(python, ['-I', '-B', '-c',
      'import io,json,sys,tarfile\nwith tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz") as archive:\n for name,value in json.loads(sys.argv[1]).items():\n  body=value.encode(); member=tarfile.TarInfo(name); member.size=len(body); archive.addfile(member,io.BytesIO(body))',
      JSON.stringify(files)], { windowsHide: true, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr.toString());
    archives.set(item.url, result.stdout);
    packages.push({ ...item, integrity: 'sha512-' + crypto.createHash('sha512').update(result.stdout).digest('base64') });
  }
  await fs.writeFile(path.join(assets, 'typescript-runtime.json'), JSON.stringify({ packages }));
  let requests = 0;
  return { repo, assets, packages, get requests() { return requests; }, request: async (url, options) => {
    requests++;
    assert.equal(options.redirect, 'error');
    assert.ok(archives.has(url));
    return new Response(archives.get(url));
  } };
}

test('preparation preserves an existing payload without making a request', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.assets, 'typescript'));
  await assert.rejects(prepareTypeScript(f.repo, { request: f.request, python }), /Preserve the existing/);
  assert.equal(f.requests, 0);
});

test('a redirected target directory is rejected before requests or cleanup', async t => {
  const f = await fixture(t), outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'typescript-outside-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'keep.txt'), 'untouched');
  await fs.symlink(outside, path.join(f.repo, 'target'), 'junction');
  await assert.rejects(prepareTypeScript(f.repo, { request: f.request, python }), /must resolve inside/);
  assert.equal(f.requests, 0);
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});

test('an archive integrity failure leaves no prepared payload or staging files', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareTypeScript(f.repo, { request: async () => new Response('corrupt fixture'), python }), /integrity mismatch/);
  await assert.rejects(fs.stat(path.join(f.assets, 'typescript')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(f.repo, 'target')), []);
});

test('verified archives still reject path traversal before extracting the payload', async t => {
  const f = await fixture(t, true);
  await assert.rejects(prepareTypeScript(f.repo, { request: f.request, python }), /Unsafe TypeScript archive member/);
  await assert.rejects(fs.stat(path.join(f.repo, 'escaped')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(f.repo, 'target')), []);
});

test('the complete pinned pair is staged with its compiler, server and provenance', async t => {
  const f = await fixture(t);
  const result = await prepareTypeScript(f.repo, { request: f.request, python });
  assert.equal(f.requests, 2);
  assert.equal(result.destination, path.join(f.assets, 'typescript'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.destination, '.codebuddy-runtime.json'), 'utf8')), { packages: f.packages });
  assert.match(await fs.readFile(path.join(result.destination, 'node_modules/typescript/lib/tsserver.js'), 'utf8'), /isolated fixture/);
  assert.match(await fs.readFile(path.join(result.destination, 'node_modules/typescript-language-server/lib/cli.mjs'), 'utf8'), /isolated fixture/);
  assert.deepEqual(await fs.readdir(path.join(f.repo, 'target')), []);
});
