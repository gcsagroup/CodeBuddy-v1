import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

// Alpha2's combined DACL + LABEL call can protect existing descendants' DACLs
// instead of propagating the workspace capability. Keep the native grants,
// per-path lock, masks, restricted runner and error handling; separate only the
// two Win32 writes. No child ACL is reset, and no process starts between them.
if (process.platform === 'win32') {
  const entry = import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl');
  const url = new URL('./types-Cl_DXjhk.js', entry).href;
  const source = readFileSync(new URL(url), 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== '0bb3a34508785bdc34626542f9358d398fd9f60fdaf4b48201dfdff2122f25fc')
    throw new Error('Review the pinned Windows ACL propagation contract.');
  const previous = 'const applyResult = api.setNamedSecurityInfoW(path, 1, labelEdit.kind === "keep" ? 4 : 20, null, null, newAcl, labelEdit.kind === "apply" ? labelEdit.acl : null);';
  if (source.split(previous).length !== 2) throw new Error('Native ACL propagation seam changed.');
  const replacement = source.replace(previous, `let applyResult = api.setNamedSecurityInfoW(path, 1, 4, null, null, newAcl, null);
\tif (applyResult === 0 && labelEdit.kind !== "keep")
\t\tapplyResult = api.setNamedSecurityInfoW(path, 1, 16, null, null, null, labelEdit.kind === "apply" ? labelEdit.acl : null);`);
  let applied = false;
  const hook = registerHooks({ load(loadedUrl, context, next) {
    const result = next(loadedUrl, context);
    if (loadedUrl !== url) return result;
    if (Buffer.from(result.source).toString('utf8') !== source) throw new Error('Native ACL source changed during loading.');
    applied = true;
    return { ...result, source: replacement };
  } });
  try {
    await import(entry);
    if (!applied) throw new Error('Load the Windows ACL contract before the native sandbox.');
  } finally { hook.deregister(); }
}
