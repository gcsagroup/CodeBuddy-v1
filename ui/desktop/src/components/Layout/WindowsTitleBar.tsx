import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

export function WindowsTitleBar() {
  const { resolvedTheme } = useTheme();
  const [items, setItems] = useState<Array<{ index: number; label: string; enabled: boolean }>>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    window.electron
      .getWindowMenu()
      .then((menu) => {
        if (active) setItems(menu);
      })
      .catch(console.error);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    window.electron.setWindowTitleBarTheme(resolvedTheme);
  }, [resolvedTheme]);

  const openMenu = async (index: number, button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect();
    setOpenIndex(index);
    try {
      await window.electron.openWindowMenu({ index, x: bounds.left, y: bounds.bottom });
    } catch (error) {
      console.error('Failed to open window menu', error);
    } finally {
      setOpenIndex(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      void openMenu(index, event.currentTarget);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)'
      )
    );
    const current = buttons.indexOf(event.currentTarget);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <header className="windows-titlebar relative z-[100] flex h-10 shrink-0 select-none items-center bg-[#f9fafb] dark:bg-background-secondary">
      <div
        id="window-navigation-slot"
        className="no-drag mx-2 flex h-8 w-8 shrink-0 items-center justify-center"
      />
      <div
        role="menubar"
        aria-label="CodeBuddy"
        className="no-drag flex min-w-0 items-center gap-0.5"
      >
        {items.map((item) => (
          <button
            key={item.index}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openIndex === item.index}
            disabled={!item.enabled}
            className={`h-7 rounded px-2 text-[13px] text-text-primary hover:bg-background-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-text-primary disabled:opacity-40 ${openIndex === item.index ? 'bg-background-tertiary' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event: MouseEvent<HTMLButtonElement>) =>
              void openMenu(item.index, event.currentTarget)
            }
            onKeyDown={(event) => handleKeyDown(event, item.index)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </header>
  );
}
