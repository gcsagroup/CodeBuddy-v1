// Matches the URI codec in the pinned Harness session-reference package.
export function conversationMention(id: string, title: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(id));
  const payload = globalThis.btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const label = title.replace(/[\\\]]/g, (character) => `\\${character}`);
  return `@[${label}](dsh-session:${payload}) `;
}

// Display projection only. Harness validates and resolves the URI on submission.
export function conversationMentions(text: string) {
  return Array.from(
    text.matchAll(/@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[A-Za-z0-9_-]+)\)/g),
    (match) => ({
      title: match[1].replace(/\\(.)/g, '$1'),
      uri: match[2],
      start: match.index!,
      end: match.index! + match[0].length,
    })
  );
}

export function splitConversationDraft(text: string) {
  const references = conversationMentions(text);
  let body = text;
  for (const reference of [...references].reverse()) {
    body = body.slice(0, reference.start) + body.slice(reference.end);
  }
  return {
    body: references.length ? body.trimEnd() : body,
    references: references
      .map((reference) => text.slice(reference.start, reference.end))
      .join('\n'),
  };
}

export function combineConversationDraft(body: string, references: string) {
  return references.trim() ? [body, references].filter((part) => part.trim()).join('\n') : body;
}
