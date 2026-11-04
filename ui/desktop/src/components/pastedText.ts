import { useEffect, useMemo, useState } from 'react';

export const LARGE_TEXT_LENGTH = 4000;

export function isLargeText(text: string): boolean {
  return text.length >= LARGE_TEXT_LENGTH || text.split('\n', 81).length > 80;
}

function restore(text: string) {
  return isLargeText(text)
    ? { prefix: text, blocks: [{ id: 'restored', text }] }
    : { prefix: '', blocks: [] };
}

// The canonical draft is always plain, complete text. Only the editor's DOM is
// shortened; history, rejection recovery, queues and ACP keep their existing contract.
export function useCompactTextInput(value: string) {
  const [collapsed, setCollapsed] = useState(() => restore(value));
  const current = useMemo(
    () => (collapsed.prefix && value.startsWith(collapsed.prefix) ? collapsed : restore(value)),
    [collapsed, value]
  );
  const { prefix, blocks } = current;
  useEffect(() => {
    if (collapsed.prefix !== prefix) setCollapsed(current);
  }, [collapsed.prefix, prefix, current]);
  return {
    prefix,
    blocks,
    editorValue: value.slice(prefix.length),
    collapse: (text: string) => setCollapsed(restore(text)),
    appendBlock: (text: string) => {
      const addition = text.startsWith(prefix) ? text.slice(prefix.length) : text;
      setCollapsed({
        prefix: text,
        blocks: [
          ...(text.startsWith(prefix) ? blocks : []),
          { id: crypto.randomUUID(), text: addition },
        ],
      });
    },
    removeBlock: (id: string) => {
      const remaining = blocks.filter((block) => block.id !== id);
      const nextPrefix = remaining.map((block) => block.text).join('');
      setCollapsed({ prefix: nextPrefix, blocks: remaining });
      return nextPrefix + value.slice(prefix.length);
    },
  };
}
