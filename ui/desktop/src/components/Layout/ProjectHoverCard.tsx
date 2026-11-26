import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';

// Unlike a tooltip, this card contains actions and must be focusable itself.
export function ProjectHoverCard({ trigger, children, label, disabled, className }: {
  trigger: ReactNode; children: ReactNode; label: string; disabled: boolean; className: string;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelTimer = () => clearTimeout(timer.current);
  const show = () => { cancelTimer(); timer.current = setTimeout(() => setOpen(true), 240); };
  const hide = () => { cancelTimer(); timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('blur', close);
    return () => { clearTimeout(timer.current); window.removeEventListener('blur', close); };
  }, []);
  return <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Anchor asChild>
      <div className="min-w-0 flex-1" onPointerEnter={show} onPointerLeave={hide} onFocus={() => { cancelTimer(); setOpen(true); }}>
        {trigger}
      </div>
    </Popover.Anchor>
    <Popover.Portal><Popover.Content side="right" align="start" sideOffset={8} collisionPadding={12}
      aria-label={label} className={`${className} z-[200] max-h-[var(--radix-popover-content-available-height)]`}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onPointerEnter={cancelTimer} onPointerLeave={hide} onFocus={cancelTimer}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      {children}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
