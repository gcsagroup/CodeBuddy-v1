import { useCallback, useEffect, useRef } from 'react';

export function useHoldToTalk(start: () => Promise<void>, stop: () => void, enabled: boolean, scope: unknown) {
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const begin = () => {
    if (held.current || !enabled) return;
    held.current = true;
    timer.current = setTimeout(() => {
      timer.current = null;
      void start();
    }, 200);
  };
  const end = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stop();
  }, [stop]);
  useEffect(() => {
    const release = (event: KeyboardEvent) => { if (event.code === 'Space') end(); };
    window.addEventListener('keyup', release);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', end);
      end();
    };
  }, [end, scope]);
  return { begin, end };
}
