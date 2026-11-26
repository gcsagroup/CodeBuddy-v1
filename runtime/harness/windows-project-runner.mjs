// Use the pinned Harness token, process Job and control-pipe implementation.
// The host has provisioned a capability scoped to this exact directory set.
import './windows-acl-contract.mjs';
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control';
import { closeSync } from 'node:fs';
const { AclSandbox, tempWriteSid } = await import('@deepseek-ai/dsh-sandbox-windows-acl');
const { projectWriteSid } = await import('./windows-project-sid.mjs');

let sandbox;
try {
  const [rawRoots, temp, sid, separator, ...argv] = process.argv.slice(2);
  const roots = JSON.parse(rawRoots);
  if (!Array.isArray(roots) || !roots.length || separator !== '--' || !argv.length || sid !== projectWriteSid(roots)) throw Error('Invalid project sandbox capability');
  sandbox = new AclSandbox({ writableDirs: roots, tempDir: temp, mode: 'workspace-write',
    writeSid: sid, tempWriteSid: tempWriteSid(temp), manageDacls: false });
  await sandbox.init();
  process.env.TEMP = temp; process.env.TMP = temp;
  const child = sandbox.spawn({ command: argv[0], args: argv.slice(1), stdio: 'inherit',
    ...(process.env[SUBPROCESS_CONTROL_ENV] === 'pipe' ? { controlFileDescriptor: SUBPROCESS_CONTROL_FD } : {}) });
  if (process.env[SUBPROCESS_CONTROL_ENV] === 'pipe') closeSync(SUBPROCESS_CONTROL_FD);
  process.exitCode = (await child.wait()).exitCode;
} catch (error) {
  process.stderr.write(`windows-acl-run: ${error.message}\n`);
  process.exitCode = 127;
} finally { sandbox?.dispose(); }
