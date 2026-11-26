import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
await import('./windows-process-errors.mjs');
await import('./windows-acl-contract.mjs');
const { canonicalPath } = await import('@deepseek-ai/dsh-sandbox');
const { AclWriteGrant, assertTempRootOutsideWorkspace, tempWriteSid } = await import('@deepseek-ai/dsh-sandbox-windows-acl');

const capabilities = new Map();
const tempRoot = resolve(tmpdir());
let closing = false;
function removeOwnedDirectory(dir) {
  const child = relative(tempRoot, resolve(dir));
  if (isAbsolute(child) || !child.startsWith('dsh-') || child.includes(sep))
    throw Error('Refusing session TEMP cleanup outside its generated directory');
  rmSync(dir, { recursive: true, force: true });
}
function acquire(policy) {
  const workspaceRoot = canonicalPath(policy.workspaceRoot);
  assertTempRootOutsideWorkspace(workspaceRoot, tmpdir());
  const sessionId = String(policy.sessionId), key = JSON.stringify([sessionId, workspaceRoot]);
  if (capabilities.has(key)) return capabilities.get(key).value;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-')), writeSid = tempWriteSid(dir);
  let grant;
  try { grant = AclWriteGrant.create(writeSid); grant.add(dir); }
  catch (error) {
    const failures = [error];
    try { grant?.dispose(); } catch (cleanup) { failures.push(cleanup); }
    try { removeOwnedDirectory(dir); } catch (cleanup) { failures.push(cleanup); }
    throw new AggregateError(failures, 'Session TEMP authorization failed');
  }
  const value = { workspaceRoot, sessionId, dir, writeSid };
  capabilities.set(key, { value, grant });
  return value;
}
function close(cleanup) {
  if (closing) return;
  closing = true;
  if (cleanup) {
    const failures = [];
    for (const { value, grant } of capabilities.values()) {
      try { grant.dispose(); } catch (error) { failures.push(error); }
      // Every target was created by this process. Never enumerate old dsh-*
      // directories or claim ownership of a crashed provider's residue.
      try { removeOwnedDirectory(value.dir); } catch (error) { failures.push(error); }
    }
    if (process.connected) process.send({ cleanupFailures: failures.length });
  }
  process.disconnect();
}
process.on('message', message => {
  if (closing) return;
  if (message.type === 'dispose' || message.type === 'abandon') { close(message.type === 'dispose'); return; }
  if (message.type !== 'acquire') return;
  try { process.send({ id: message.id, value: acquire(message.policy) }); }
  catch (error) { process.send({ id: message.id, error: error.message }); }
});
// Losing the host is not proof that every previously launched command has
// exited. Leave random grants intact, matching native crash-residue semantics.
process.on('disconnect', () => process.exit(0));
