'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { buildMacCredentials } = require('../ui/desktop/scripts/build-macos-credentials.cjs');
const { buildMacComputer } = require('../ui/desktop/scripts/build-macos-computer.cjs');
const { targetFor, verifyMachO, sha256 } = require('../ui/desktop/scripts/macos-package.cjs');
const { macArtifactFiles } = require('../runtime/builtin-artifacts.mjs');
const { writeMacArtifacts, verifyMacArtifacts } = require('./macos-tool-artifacts.cjs');
const { signingPlan, inspectSignature } = require('../ui/desktop/scripts/macos-signing.cjs');

function replaceMacExecutable(source, destination) {
  // macOS caches signing information by inode: never overwrite executed code.
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.replace-'));
  try {
    const staged = path.join(temporary, path.basename(destination));
    fs.copyFileSync(source, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, shell: false,
    ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' }) });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
  return result.stdout?.trim();
}

function buildMacTools(repo, arch, verifiedSource) {
  const target = targetFor(arch);
  if (process.platform !== 'darwin' || process.arch !== arch)
    throw new Error(`Build MCP tools on a native ${arch} Mac`);
  const source = {
    revision: run('git', ['rev-parse', 'HEAD'], repo, true),
    dirty: run('git', ['status', '--porcelain'], repo, true).length > 0,
    ...verifiedSource,
    rustTarget: target,
  };
  const cargoOutput = JSON.parse(run('cargo', ['metadata', '--offline', '--no-deps', '--format-version', '1'], repo, true)).target_directory;
  // Offline is deliberate: missing dependencies are preparation work, never an
  // implicit installation during preview/packaging. Only one Cargo build runs.
  run('cargo', ['build', '--offline', '--release', '-p', 'goose-mcp', '--features', 'rustls-tls', '--bin', 'codebuddy-tools', '--target', target, '--jobs', '1'], repo);
  const computer = buildMacComputer(repo, arch);
  const parent = path.join(repo, 'target/codebuddy-package');
  fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, `tools-${arch}-`));
  fs.mkdirSync(path.join(output, 'bin'));
  const binaries = {
    credentials: buildMacCredentials(repo, arch),
    tools: path.join(cargoOutput, target, 'release/codebuddy-tools'),
    computer: path.join(computer, 'qwen-computer-use'),
    helper: path.join(computer, 'qwen-computer-runtime'),
  };
  for (const [key, file] of Object.entries(macArtifactFiles)) {
    verifyMachO(binaries[key], arch);
    fs.copyFileSync(binaries[key], path.join(output, 'bin', file));
    fs.chmodSync(path.join(output, 'bin', file), 0o755);
  }
  fs.mkdirSync(path.join(output, 'licenses'));
  const licenses = [
    ['Apache-2.0', path.join(repo, 'LICENSE'), 'codebuddy-tools-Apache-2.0.txt'],
    ['MIT', path.join(repo, 'tools/qwen-computer-use/LICENSE'), 'qwen-computer-use-macos-MIT.txt'],
  ].map(([license, original, file]) => {
    const destination = path.join(output, 'licenses', file);
    fs.copyFileSync(original, destination);
    return { license, file: `licenses/${file}`, sha256: sha256(destination) };
  });
  writeMacArtifacts(output, arch, source);
  fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({
    schemaVersion: 1, platform: 'darwin', architecture: arch, source, licenses,
    purpose: 'Independent tool-only MCP services; Harness retains all Agent execution and permissions.',
    licenseNote: 'First-party license texts are included. Audit transitive binary notices before public release.',
    artifactManifest: 'artifacts.json',
  }, null, 2) + '\n');
  verifyMacArtifacts(output, arch, 'staged');
  return output;
}

function main() {
  const { values } = parseArgs({ options: { arch: { type: 'string', default: process.arch }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/prepare-harness-macos-tools.cjs --arch arm64|x64\nBuilds native offline Rust MCP and Go/Swift computer tools, then updates only the matching Mac preview artifacts. No tests are run.');
    return;
  }
  const repo = path.resolve(__dirname, '..');
  const output = buildMacTools(repo, values.arch);
  // Keychain grants follow the helper's designated requirement across preview builds.
  if (process.env.CODEBUDDY_MAC_SIGN_IDENTITY?.trim()) {
    const plan = signingPlan({ CODEBUDDY_MAC_SIGN_IDENTITY: process.env.CODEBUDDY_MAC_SIGN_IDENTITY });
    const helper = path.join(output, 'bin', macArtifactFiles.credentials);
    run('codesign', ['--force', '--options', 'runtime', '--timestamp=none', '--sign', plan.identity, helper], repo);
    run('codesign', ['--verify', '--strict', helper], repo);
    inspectSignature(helper, plan);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'artifacts.json'), 'utf8'));
    writeMacArtifacts(output, values.arch, manifest.source);
    verifyMacArtifacts(output, values.arch, 'staged');
  }
  const destination = path.join(repo, 'runtime/tools');
  fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
  for (const file of Object.values(macArtifactFiles)) {
    replaceMacExecutable(path.join(output, 'bin', file), path.join(destination, 'bin', file));
  }
  fs.cpSync(path.join(output, 'licenses'), path.join(destination, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(output, 'provenance.json'), path.join(destination, 'provenance.macos.json'));
  // Commit the manifest last: partially copied artifacts stay unavailable.
  const temporary = path.join(destination, `.artifacts-${process.pid}.json`);
  fs.copyFileSync(path.join(output, 'artifacts.json'), temporary);
  fs.renameSync(temporary, path.join(destination, 'artifacts.json'));
  verifyMacArtifacts(destination, values.arch, 'staged');
  console.log(`Prepared native preview tools from ${output}`);
}

module.exports = { buildMacTools, replaceMacExecutable };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
