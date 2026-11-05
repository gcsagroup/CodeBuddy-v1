import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

// Schedule metadata can reach this entry before the lazy execution driver.
// Subagent modules also import the LLM service, so budget seams must load first.
await import('./tool-error-contract.mjs');

// DSH 0.2.1-alpha.2 mandates a manual report in addition to native settlement.
// Patch only its two model-facing statements, retaining the original module
// identities and every lifecycle implementation. Never write into node_modules.
// Remove when upstream exposes an automatic-final-report contract.
const patches = [
  {
    name: '@deepseek-ai/dsh-subagent',
    hash: '09da454106ce761ac44137366a03c9fbe485a4d21f23d1aa117b2e38f82150fa',
    previous: 'Before you finish, send your result to that agent with send_message({ agent_id: ${encodedParentId}, message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.',
    replacement: 'Your final response is automatically delivered to that agent when this activation settles. Put the self-contained result, limitations and unresolved questions in your final response; do not send_message just to deliver that same final result. The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Use send_message when coordination is needed before you finish; sending a message does not end your turn. Finishing leaves this conversation reusable for later assignments.',
  },
  {
    name: '@deepseek-ai/dsh-tool-subagent',
    hash: 'a155eac1e9acc532d43899e31915d6f7c856c6cf30fd34a327b2295643773526',
    previous: 'The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes.',
    replacement: 'The completion notice automatically includes its final answer. Use `send_message` for coordination while running or a new assignment after it finishes; the child does not need to send the same final answer separately.',
  },
];
for (const patch of patches) {
  const nativeUrl = import.meta.resolve(patch.name);
  const source = readFileSync(new URL(nativeUrl), 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== patch.hash || source.split(patch.previous).length !== 2)
    throw new Error(`Review the native subagent return-contract patch for ${patch.name}.`);
  let applied = false;
  const hook = registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== nativeUrl) return loaded;
      if (Buffer.from(loaded.source).toString('utf8') !== source)
        throw new Error(`Native source changed during return-contract loading: ${patch.name}`);
      applied = true;
      return { ...loaded, source: source.replace(patch.previous, patch.replacement) };
    },
  });
  try {
    await import(patch.name);
    if (!applied) throw new Error(`Load the subagent return contract before ${patch.name}.`);
  } finally {
    hook.deregister();
  }
}
