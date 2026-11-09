import { useLayoutEffect, useRef, useState, type CSSProperties, type ComponentRef } from 'react';
import './conversation-title.css';

/** Keep the accessible title intact; reveal overflow without changing row width. */
export function ConversationTitle({ children }: { children: string }) {
  const viewport = useRef<ComponentRef<'span'>>(null);
  const text = useRef<ComponentRef<'span'>>(null);
  // Presentation only: reserve the numeric copy suffix while the name scrolls.
  const suffix = children.match(/ \(\d+\)$/)?.[0] ?? '';
  const name = suffix ? children.slice(0, -suffix.length) : children;
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setOverflow(Math.max(0,
      (text.current?.scrollWidth ?? 0) - (viewport.current?.clientWidth ?? 0)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (text.current) observer.observe(text.current);
    return () => observer.disconnect();
  }, [children]);
  return (
    <span className="conversation-label" aria-label={children}>
    <span ref={viewport} className="conversation-title" data-overflow={overflow > 0}
      style={{ '--title-travel': `${-(overflow + 24)}px`, '--title-duration': `${Math.max(5, overflow / 28 + 2)}s` } as CSSProperties}>
      <span ref={text} className="conversation-title-text">{name}</span>
    </span>
    {suffix && <span className="conversation-title-number">{suffix}</span>}
    </span>
  );
}
