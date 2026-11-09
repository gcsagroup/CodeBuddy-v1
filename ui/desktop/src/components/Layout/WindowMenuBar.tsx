import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

export function WindowMenuBar() {
  const { resolvedTheme } = useTheme();
  const [items, setItems] = useState<Array<{ index: number; label: string; enabled: boolean }>>([]);
  const [open, setOpen] = useState<number | null>(null);
  const bar = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const custom = window.electron?.platform === 'win32';

  useEffect(() => {
    if (!custom) return;
    let active = true;
    const refresh = () =>
      void window.electron
        .getWindowMenu()
        .then((menu) => {
          if (active) setItems(menu);
        })
        .catch(console.error);
    refresh();
    window.addEventListener('focus', refresh);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'F10' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        returnFocus.current = document.activeElement as HTMLElement;
        bar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('keydown', keyboard);
    };
  }, [custom]);

  useEffect(() => {
    if (custom) void window.electron.setTitlebarTheme(resolvedTheme).catch(console.error);
  }, [custom, resolvedTheme]);

  if (!custom)
    return window.electron?.platform === 'darwin' ? <div className="titlebar-drag-region" /> : null;
  return (
    <header className="window-menu-bar">
      <nav
        ref={bar}
        role="menubar"
        aria-label="Application menu"
        onKeyDown={(event) => {
          const buttons = Array.from(
            bar.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
          );
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            buttons[
              (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus();
          } else if (event.key === 'Escape') {
            returnFocus.current?.focus();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            buttons[index]?.click();
          }
        }}
      >
        {items.map((item) => (
          <button
            key={item.index}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === item.index}
            disabled={!item.enabled}
            onMouseDown={(event) => {
              returnFocus.current = document.activeElement as HTMLElement;
              // Native Edit roles act on the focused editor, not the menu button.
              event.preventDefault();
            }}
            onClick={async (event) => {
              const button = event.currentTarget;
              const bounds = button.getBoundingClientRect();
              setOpen(item.index);
              try {
                returnFocus.current?.focus();
                await window.electron.openWindowMenu(item.index, bounds.left, bounds.bottom);
              } catch (error) {
                console.error('Unable to open application menu', error);
              } finally {
                setOpen(null);
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
