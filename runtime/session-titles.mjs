/** Product titles are shared by the chat header, sidebar and history. */
export function isPlaceholderTitle(title) {
  return title === 'New Session' || title === '新对话';
}

const titleFields = ['id', 'title', 'messageCount', 'globalConversation', 'readonlyHistory', 'userSetName', 'nativeSessionId'];

function needsTitle(session) {
  return session && !session.globalConversation && !session.readonlyHistory &&
    !session.userSetName && isPlaceholderTitle(session.title);
}

function applyTitle(saved, original, title) {
  if (needsTitle(saved) && saved.nativeSessionId === original.nativeSessionId &&
      typeof title === 'string' && title.trim() && !isPlaceholderTitle(title.trim())) {
    saved.title = title.trim();
  }
}

export function proposeFirstTurnTitle(host, original, users, updates, signal, early = false) {
  if (!needsTitle(original) || original.messageCount > 0 || signal.aborted) return;
  const user = users.filter(update => !update._meta?.goose?.scheduled && update.content?.type === 'text')
    .map(update => update.content.text).join('\n').trim().slice(0, 6000);
  if (!user) return;
  const assistant = updates.filter(update => update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text')
    .map(update => update.content.text).join('').trim().slice(0, 6000);
  // A tool turn often has no assistant prose until its final answer. Its
  // original topic is already available; do not serialize naming after it.
  return host.driver.generateTitle(original.id, { user, assistant, ...(early && !assistant ? { topicOnly: true } : {}) }, signal).catch(() => undefined);
}

export async function nameFirstTurn(host, original, users, updates, signal, proposal) {
  try {
    const title = await (proposal ?? proposeFirstTurnTitle(host, original, users, updates, signal));
    if (signal.aborted || !title || isPlaceholderTitle(title)) return;
    await host.store.updateSession(original.id, saved => {
      if (!signal.aborted) applyTitle(saved, original, title);
    });
  } catch { console.error('[session title] Could not project the first-turn title'); }
}

export async function restoreMissingTitles(host) {
  const candidates = host.store.read(['sessions'], { sessionFields: titleFields }).sessions
    .filter(session => needsTitle(session) && session.messageCount > 0);
  if (!candidates.length) return;
  // The native title is already durable. Repair only the product projection,
  // without running inference, replaying work or reordering old chats.
  const native = await host.driver.listSessions();
  const titles = new Map(native.map(row => [row.sessionId, row.projections?.values?.title]));
  for (const original of candidates) {
    if (host.closing) break;
    if (!titles.has(original.id)) continue;
    let title = titles.get(original.id);
    if (!title) {
      // A cold session can lack a projection-cache entry after a crash.
      try {
        const history = await host.driver.history(original.id);
        title = history.events.findLast(event => event.type === 'session/title')?.data.title;
      } catch {
        console.error('[session title] Could not read the native title for', original.id);
        continue;
      }
    }
    if (title && !isPlaceholderTitle(title)) {
      let updated;
      await host.store.updateSession(original.id, saved => {
        const previous = saved.title;
        if (!host.closing) applyTitle(saved, original, title);
        if (saved.title !== previous) updated = saved.title;
      });
      if (updated) for (const connection of host.connections ?? []) {
        if (!connection.background) connection.notify('session/update', {
          sessionId: original.id, update: { sessionUpdate: 'session_info_update', title: updated },
        });
      }
    }
  }
}
