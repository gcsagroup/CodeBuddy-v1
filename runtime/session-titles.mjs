/** Product title projection only; auxiliary inference uses the existing Harness model route. */
export async function nameFirstTurn(host, original, updates, signal) {
  if (original.globalConversation || original.userSetName || original.messageCount > 0 || signal.aborted || typeof host.driver.generateTitle !== 'function') return;
  const current = host.session(original.id);
  if (current.userSetName || !['New Session', '新对话'].includes(current.title)) return;
  const user = current.updates.filter(update => update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text').map(update => update.content.text).join('\n').slice(0, 6000);
  const assistant = updates.filter(update => update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text').map(update => update.content.text).join('').slice(0, 6000);
  if (!assistant) return;
  try {
    const title = await host.driver.generateTitle(original.id, { user, assistant });
    if (signal.aborted) return;
    await host.store.update(state => {
      const saved = state.sessions.find(item => item.id === original.id);
      if (saved && !saved.userSetName && saved.nativeSessionId === current.nativeSessionId && saved.title === current.title) saved.title = title;
    });
  } catch { console.error('[session title] Generation unavailable; keeping the default title'); }
}
