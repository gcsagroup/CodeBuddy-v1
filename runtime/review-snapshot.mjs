import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createGitReader } from './git-extension.mjs';
import { createReviewDiffer } from './review-diff.mjs';

const FILE_BYTES = 64 * 1024, CONTENT_BYTES = 256 * 1024, FILES = 200;
const hash = value => createHash('sha256').update(value).digest('hex');
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const normalize = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const omitted = reason => ({ reason });

function validatePath(file) {
  if (typeof file !== 'string' || !file || file.length > 4096 || /[\0\\:]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(file)) throw Error('invalid_review_path');
}
function sensitive(file) {
  const value = file.toLowerCase(), name = value.split('/').at(-1);
  if (['.env.example', '.env.sample', '.env.template'].includes(name)) return false;
  return name === '.env' || name.startsWith('.env.') || ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', 'credentials.json', 'service-account.json'].includes(name) || /\.(pem|key|p12|pfx|jks|keystore)$/.test(name) || /(^|\/)\.ssh\//.test(value) || /(^|\/)\.aws\/credentials$/.test(value);
}
function rawEntries(bytes) {
  const records = decode(bytes).split('\0'), entries = [];
  for (let i = 0; i < records.length && records[i];) {
    const header = records[i++], parts = header.slice(1).split(' ');
    if (!header.startsWith(':') || parts.length !== 5 || parts[4] === 'U') throw Error('review_unmerged_or_invalid_diff');
    const first = records[i++], renamed = /^[RC]/.test(parts[4]);
    const file = renamed ? records[i++] : first;
    validatePath(file); if (renamed) validatePath(first);
    entries.push({ path: file, originalPath: renamed ? first : null, status: parts[4], oldMode: parts[0], newMode: parts[1], oldOid: parts[2], newOid: parts[3] });
  }
  return entries;
}

async function readWorking(root, file) {
  validatePath(file);
  let cursor = root;
  for (const part of file.split('/')) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || normalize(await realpath(cursor)) !== normalize(cursor)) return omitted('non_regular_file');
  }
  const before = await lstat(cursor, { bigint: true });
  if (!before.isFile()) return omitted('non_regular_file');
  if (before.size > BigInt(FILE_BYTES)) return omitted('file_too_large');
  const fd = await open(cursor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await fd.stat({ bigint: true });
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || normalize(await realpath(cursor)) !== normalize(cursor)) throw Error('review_file_identity_changed');
    const bytes = Buffer.alloc(FILE_BYTES + 1); let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await fd.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw Error('repository_changed');
    return bytesRead > FILE_BYTES ? omitted('file_too_large') : bytes.subarray(0, bytesRead);
  } finally { await fd.close(); }
}

/** Capture only Git and filesystem facts; snapshot content is untrusted model input. */
export async function captureReviewSnapshot({ sessionId, cwd, scope, baseRef = null, model }, { signal } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  if (!sessionId || !model?.provider || !model?.model || !['working_tree', 'staged', 'branch'].includes(scope)) throw Error('invalid_review_identity_or_scope');
  if (scope === 'branch') {
    if (typeof baseRef !== 'string' || !baseRef || baseRef.length > 200 || baseRef.startsWith('-') || baseRef.includes('..') || !/^[\p{L}\p{N}/_.-]+$/u.test(baseRef)) throw Error('invalid_review_base');
  } else if (baseRef != null) throw Error('review_base_not_allowed');
  const git = createGitReader(cwd), root = await realpath(await git.root(signal)), differ = createReviewDiffer(signal);
  const baseOptions = { directory: root, signal };
  const run = async (args, allowedExitCodes = []) => git.run(args, { ...baseOptions, allowedExitCodes });
  const required = async args => (await run(args)).stdout;
  async function blob(oid) {
    if (!oid || /^0+$/.test(oid)) return Buffer.alloc(0);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw Error('invalid_review_oid');
    const size = Number(decode(await required(['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw Error('invalid_review_blob_size');
    if (size > FILE_BYTES) return omitted('file_too_large');
    const bytes = await required(['cat-file', 'blob', oid]);
    if (bytes.length !== size) throw Error('review_blob_size_changed');
    return bytes;
  }
  async function capture() {
    signal?.throwIfAborted();
    const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [1]);
    let headOid = head.exitCode === 0 ? decode(head.stdout).trim() : null;
    if (!headOid) {
      const symbolic = decode(await required(['symbolic-ref', '-q', 'HEAD'])).trim();
      if ((await run(['show-ref', '--verify', '--quiet', symbolic], [1])).exitCode !== 1) throw Error('review_head_unavailable');
    }
    const argv = ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv'];
    let baseOid = null, baseTip = null;
    if (scope === 'staged') { argv.push('--cached'); if (headOid) argv.push(headOid); }
    if (scope === 'branch') {
      if (!headOid) throw Error('review_head_required');
      baseTip = decode(await required(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).trim();
      baseOid = decode(await required(['merge-base', baseTip, headOid])).trim();
      argv.push(baseOid, headOid);
    }
    argv.push('--');
    const raw = await required(argv), entries = rawEntries(raw);
    const untracked = scope === 'working_tree' ? await required(['ls-files', '--others', '--exclude-standard', '-z']) : Buffer.alloc(0);
    for (const file of decode(untracked).split('\0').filter(Boolean)) {
      validatePath(file); entries.push({ path: file, originalPath: null, status: 'A', oldMode: '000000', newMode: '100644', oldOid: '', newOid: '' });
    }
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const files = [], excludedFiles = []; let size = 0;
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      let reason = index >= FILES ? 'file_limit' : sensitive(entry.path) || (entry.originalPath && sensitive(entry.originalPath)) ? 'sensitive_path' : [entry.oldMode, entry.newMode].some(mode => !['000000', '100644', '100755'].includes(mode)) ? 'non_regular_file' : null;
      if (reason) { excludedFiles.push({ path: entry.path, reason }); continue; }
      const oldBytes = await blob(entry.oldOid);
      const newBytes = entry.newMode === '000000' ? Buffer.alloc(0) : scope === 'working_tree' ? await readWorking(root, entry.path) : await blob(entry.newOid);
      reason = oldBytes.reason ?? newBytes.reason;
      let oldText, newText;
      if (!reason) {
        try { if (oldBytes.includes(0) || newBytes.includes(0)) throw Error(); oldText = decode(oldBytes); newText = decode(newBytes); }
        catch { reason = 'binary_or_non_utf8'; }
      }
      if (reason) { excludedFiles.push({ path: entry.path, reason }); continue; }
      const patch = await differ.diff(oldText, newText);
      const bytes = oldBytes.length + newBytes.length + Buffer.byteLength(patch.diff);
      if (size + bytes > CONTENT_BYTES) { excludedFiles.push({ path: entry.path, reason: 'content_limit' }); continue; }
      size += bytes;
      files.push({ path: entry.path, originalPath: entry.originalPath, status: entry.status, oldText, newText, oldHash: hash(oldBytes), newHash: hash(newBytes), ...patch });
    }
    const fingerprint = hash(JSON.stringify([root, sessionId, scope, baseRef, headOid, baseOid, baseTip, model, hash(raw), hash(untracked), files, excludedFiles]));
    return { schemaVersion: 1, snapshotId: '', sessionId, scope, baseRef, headOid, baseOid, model: structuredClone(model), files, coverage: excludedFiles.length ? 'partial' : 'complete', excludedFiles, fingerprint, capturedAt: '' };
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const first = await capture(), second = await capture();
      if (first.fingerprint === second.fingerprint) return { ...second, snapshotId: randomUUID(), capturedAt: new Date().toISOString() };
    }
    throw Error('repository_changed');
  } finally { await differ.close(); }
}
