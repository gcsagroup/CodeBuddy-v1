const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyMachO, targetFor } = require('./macos-package.cjs');

function buildMacCredentials(repo, arch, { test = false } = {}) {
  targetFor(arch);
  if (process.platform !== 'darwin' || process.arch !== arch)
    throw new Error(`Build credential protection on a native ${arch} Mac.`);
  const source = path.join(repo, 'tools/macos-credentials');
  const parent = path.join(repo, 'target/codebuddy-package');
  fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, `credentials-${arch}-`));
  const common = ['swiftc', '-parse-as-library', '-O', '-target',
    `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, path.join(source, 'CredentialStore.swift')];
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
  }
  if (test) {
    const checks = path.join(output, 'credential-tests');
    run('xcrun', [...common, path.join(source, 'contract-tests.swift'), '-o', checks]);
    run(checks, []);
  }
  const binary = path.join(output, 'codebuddy-credentials');
  run('xcrun', [...common, path.join(source, 'main.swift'), '-o', binary]);
  verifyMachO(binary, arch);
  fs.chmodSync(binary, 0o755);
  return binary;
}
module.exports = { buildMacCredentials };
