import { Children, isValidElement, useRef, type ReactNode } from 'react';

// Attachment kinds have separate preparation pipelines. Preserve when each
// keyed tile first appeared instead of regrouping it whenever decoding finishes.
export function ComposerAttachmentTray({ children }: { children: ReactNode }) {
  const order = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const tiles = Children.toArray(children).filter(isValidElement);
  for (const tile of tiles) {
    const key = String(tile.key);
    if (!order.current.has(key)) order.current.set(key, sequence.current++);
  }
  const present = new Set(tiles.map((tile) => String(tile.key)));
  for (const key of order.current.keys()) if (!present.has(key)) order.current.delete(key);
  tiles.sort((a, b) => order.current.get(String(a.key))! - order.current.get(String(b.key))!);
  return (
    <div
      data-testid="composer-attachments"
      style={{ scrollbarWidth: 'none' }}
      className="flex min-w-0 max-h-[min(16rem,35vh)] flex-nowrap items-end gap-2 overflow-x-auto overflow-y-hidden px-2 pt-2 pb-1 [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden"
    >
      {tiles}
    </div>
  );
}
