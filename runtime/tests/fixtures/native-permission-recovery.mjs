import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarnessDriver } from '../../harness/index.mjs';
import { createConversationDriver } from '../../conversation-driver.mjs';
import { Compat } from '../../compat.mjs';
import { openStore } from '../../store.mjs';
import { SafetyPolicy } from '../../safety-policy.mjs';

const { root, session, provider, key } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const store = await openStore(join(root, 'host'));
const raw = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
try {
  const driver = createConversationDriver(raw, store);
  const host = Object.assign(Object.create(Compat.prototype), { store, driver, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  // Stale product metadata and a different creation default must not overwrite
  // the native root or the existing child's independently persisted policy.
  await driver.createSession({ sessionId: session.id, cwd: session.cwd, provider, model: 'fixture', options: { initialPermissionPreset: 'danger-full-access' } });
  assert.equal((await driver.permissions(session.id)).preset, 'read-only');
  await driver.prompt(session.id, key, {
    onToolPolicy: call => host.toolPolicy(session, call, call.signal),
    onPermission() { assert.fail('The recovered child must use its native delegated policy'); },
  });
  console.log('RECOVERY_VERIFIED');
} finally { await raw.close(); }
