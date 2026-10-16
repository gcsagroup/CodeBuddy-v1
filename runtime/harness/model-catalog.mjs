import { Context } from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import * as pi from '@deepseek-ai/dsh-llm-pi-ai';

// Read the installed adapter's public schema, not another host-owned limit.
export const DEFAULT_CONTEXT_WINDOW = pi.Config.dict.providers.inner.dict.defaultContextWindow.meta.default;

// Metadata only: no agent loop, sessions, storage, credentials or execution host.
export async function catalogModels(provider) {
  const ctx = new Context();
  const llm = ctx.plugin(Llm);
  await llm;
  const adapter = ctx.plugin(pi, { providers: {} });
  try {
    await adapter;
    return await ctx.llm.discoverModels('llm-pi-ai', { provider });
  } finally {
    await adapter.dispose();
    await llm.dispose();
  }
}
