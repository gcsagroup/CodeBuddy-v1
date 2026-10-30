import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setPaused } from './native-schedule-pause-method.mjs';

await import('./subagent-return-contract.mjs');

// Local extension of the pinned native owner; never mutate node_modules.
// Upstream changes require reviewing queue, storage and recurrence semantics.
const name = '@deepseek-ai/dsh-schedule';
const url = import.meta.resolve(name);
const source = readFileSync(new URL(url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
if (version !== '0.2.1-alpha.2' || createHash('sha256').update(source).digest('hex') !==
    '022b9f191b6ca0f4b0f26625afc49f375933068a42712c0a75e94e439d7e6d0e')
  throw new Error('Review the pinned native Schedule pause contract before upgrading DSH.');
let replacement = source;
function replaceOnce(before, after) {
  if (replacement.split(before).length !== 2) throw new Error('Native Schedule pause seam changed.');
  replacement = replacement.replace(before, after);
}
replaceOnce('status: z$1.enum(["active", "inactive"]).default("active")',
  'status: z$1.enum(["active", "inactive", "paused"]).default("active")');
// Paused tasks still belong to their chat. Archive must not leave resumable
// reminders attached to a closed chat, or omit them from archive admission.
replaceOnce('const active = await this.list({ sessionId });',
  'const active = (await this.catalog()).filter(task => task.sessionId === sessionId && task.status !== "inactive");');
replaceOnce('const active = [...tasks.entries()].filter(([, task]) => task.sessionId === sessionId && task.status === "active").map(([, task]) => task.record.id);',
  'const active = [...tasks.entries()].filter(([, task]) => task.sessionId === sessionId && task.status !== "inactive").map(([, task]) => task.record.id);');
replacement += `\nScheduleService.prototype.setPaused = ${setPaused.toString()};\n`;
let applied = false;
const hook = registerHooks({ load(target, context, nextLoad) {
  const loaded = nextLoad(target, context);
  if (target !== url) return loaded;
  if (Buffer.from(loaded.source).toString('utf8') !== source) throw new Error('Native Schedule source changed during loading.');
  applied = true;
  return { ...loaded, source: replacement };
} });
try {
  await import(name);
  if (!applied) throw new Error('Load the Schedule contract before the native Schedule module.');
} finally { hook.deregister(); }
