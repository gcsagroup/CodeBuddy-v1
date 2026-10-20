'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { macArtifactFiles, parseMacArtifacts } = require('../runtime/builtin-artifacts.mjs');
const { verifyMachO, sha256, targetFor } = require('../ui/desktop/scripts/macos-package.cjs');

function describeArtifacts(directory, arch) {
  targetFor(arch);
  return Object.fromEntries(Object.entries(macArtifactFiles).map(([key, file]) => {
    const binary = path.join(directory, 'bin', file);
    const info = fs.lstatSync(binary);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected ordinary tool binary: ${file}`);
    verifyMachO(binary, arch);
    if (process.platform !== 'win32') fs.accessSync(binary, fs.constants.X_OK);
    return [key, { file, bytes: info.size, sha256: sha256(binary) }];
  }));
}

function writeMacArtifacts(directory, arch, source) {
  const artifacts = describeArtifacts(directory, arch);
  const manifest = { schemaVersion: 1, platform: 'darwin', arch, phase: 'staged', source, artifacts };
  fs.writeFileSync(path.join(directory, 'artifacts.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function verifyMacArtifacts(directory, arch, phase) {
  const file = path.join(directory, 'artifacts.json');
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    throw new Error('Expected ordinary Mac tool artifact manifest');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = parseMacArtifacts(manifest, arch);
  if (phase && manifest.phase !== phase) throw new Error(`Expected ${phase} Mac tool artifacts`);
  const actual = describeArtifacts(directory, arch);
  for (const key of Object.keys(macArtifactFiles)) {
    if (actual[key].bytes !== expected[key].bytes || actual[key].sha256 !== expected[key].sha256)
      throw new Error(`Mac tool artifact identity differs: ${expected[key].file}`);
  }
  return manifest;
}

// osx-sign's binary-file discovery also sees images, Python bytecode and npm's
// foreign-platform prebuilds. Only Mach-O code receives a nested code signature;
// all other files remain ordinary resources covered by the outer app seal.
function ignoreNonMacCode(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink()) return true;
  if (info.isDirectory()) return false;
  const header = Buffer.alloc(4);
  const descriptor = fs.openSync(file, 'r');
  let bytes;
  try { bytes = fs.readSync(descriptor, header, 0, 4, 0); }
  finally { fs.closeSync(descriptor); }
  return bytes !== 4 || ![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
    0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE(0));
}

// @electron/osx-sign signs children first, then calls optionsForFile(app).
// Refresh only the final tool identities before that last seal; modifying the
// manifest after signing/notarization would invalidate the application's seal.
function macSigningOptionsForFile(file, entitlements, hardenedRuntime = true) {
  if (file.endsWith('.app')) {
    const directory = path.join(file, 'Contents/Resources/harness-distribution/runtime/tools');
    const manifestPath = path.join(directory, 'artifacts.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      parseMacArtifacts(manifest, manifest.arch);
      const sourceArtifacts = manifest.sourceArtifacts || manifest.artifacts;
      const artifacts = describeArtifacts(directory, manifest.arch);
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, phase: 'signed', sourceArtifacts, artifacts }, null, 2) + '\n');
    }
  }
  return { entitlements, hardenedRuntime };
}

module.exports = { describeArtifacts, writeMacArtifacts, verifyMacArtifacts, macSigningOptionsForFile, ignoreNonMacCode };
