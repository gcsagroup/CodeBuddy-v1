import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';

export function projectWriteSid(roots) {
  const identity = roots.map(root => resolve(root).toLowerCase()).sort();
  // A changed membership gets a different capability. Standing ACEs from an
  // earlier configuration must not grant removed folders to later sessions.
  return workspaceWriteSid(resolve(roots[0], '.codebuddy-capability-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex')));
}
