import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { readFile, lstat, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolRoot = fileURLToPath(new URL('./tools/', import.meta.url));
const windowsArtifacts = {
  tools: { file: 'codebuddy-tools.exe', bytes: 21821440, sha256: '6e2cd0c832c9d83756c0cd27feb592c0e5e5760ba2bce7cb3c7d362dfc27a72a' },
  computer: { file: 'qwen-computer-use.exe', bytes: 4736000, sha256: '5b08525ee3825d611a4ef643badbdf15dd55e95816e4f5f15fd06dbe30c5f9b8' },
};
export const macArtifactFiles = Object.freeze({
  tools: 'codebuddy-tools', computer: 'qwen-computer-use', helper: 'qwen-computer-runtime', credentials: 'codebuddy-credentials',
});

export function parseMacArtifacts(value, arch) {
  if (!['arm64', 'x64'].includes(arch) || value?.schemaVersion !== 1 ||
      value.platform !== 'darwin' || value.arch !== arch || !['staged', 'signed'].includes(value.phase))
    throw new Error(`Invalid builtin MCP artifact manifest for darwin/${arch}`);
  const artifacts = {};
  for (const [key, file] of Object.entries(macArtifactFiles)) {
    const entry = value.artifacts?.[key];
    if (entry?.file !== file || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error(`Invalid builtin MCP artifact identity: ${file}`);
    artifacts[key] = { file, bytes: entry.bytes, sha256: entry.sha256 };
  }
  return artifacts;
}

// Packaging owns this manifest. Configuration and environment variables cannot
// replace commands, choose binaries, or extend the fixed service allowlist.
export async function builtinArtifacts(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return windowsArtifacts;
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch))
    throw new Error(`Bundled MCP artifact has not been supplied for ${platform}/${arch}`);
  const file = path.join(toolRoot, 'artifacts.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file)
      throw new Error('Builtin MCP artifact manifest must be an ordinary bundled file');
    return parseMacArtifacts(JSON.parse(await readFile(file, 'utf8')), arch);
  } catch (error) {
    throw new Error(`Bundled MCP artifacts unavailable for darwin/${arch}: ${error.message}`);
  }
}

const binDirectory = path.join(toolRoot, "bin");
const verified = new Map();
const normalizePath = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export async function verifiedBinary(artifact) {
  const file = path.join(binDirectory, artifact.file);
  const info = await lstat(file, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== BigInt(artifact.bytes) ||
    normalizePath(await realpath(file)) !== normalizePath(file)
  ) {
    throw new Error(`Bundled MCP artifact identity is invalid: ${artifact.file}`);
  }
  if (process.platform !== 'win32') await access(file, constants.X_OK);
  const signature = [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":");
  const cached = verified.get(file);
  if (cached?.signature === signature && cached.sha256 === artifact.sha256) return cached.promise;
  const promise = (async () => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    if (hash.digest("hex") !== artifact.sha256)
      throw new Error(`Bundled MCP artifact checksum differs: ${artifact.file}`);
    const current = await lstat(file, { bigint: true });
    if (
      [
        current.dev,
        current.ino,
        current.size,
        current.mtimeNs,
        current.ctimeNs,
      ].join(":") !== signature
    )
      throw new Error(
        `Bundled MCP artifact changed during verification: ${artifact.file}`,
      );
    return file;
  })();
  verified.set(file, { signature, sha256: artifact.sha256, promise });
  try {
    return await promise;
  } catch (error) {
    verified.delete(file);
    throw error;
  }
}
