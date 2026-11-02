import { useEffect, useRef } from 'react';
import { useIntl } from '../i18n';
import { cn } from '../utils';
import { panelMessages as m } from './workspacePanelMessages';

export function PanelResizeHandle({
  width,
  resizing = false,
  chatCollapsed = false,
  onWidthChange,
  onChatCollapsedChange,
  onResetWidth,
}: {
  width: number;
  resizing?: boolean;
  chatCollapsed?: boolean;
  onWidthChange?: (width: number, commit?: boolean) => void;
  onChatCollapsedChange?: (collapsed: boolean) => void;
  onResetWidth?: () => void;
}) {
  const intl = useIntl();
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => resizeCleanup.current?.(), []);
  return (
    <div
      role="separator"
      aria-label={intl.formatMessage(m.resize)}
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className="no-drag group absolute left-0 top-0 bottom-0 z-30 w-1.5 cursor-col-resize touch-none outline-none"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (chatCollapsed && e.key === 'ArrowRight') onChatCollapsedChange?.(false);
          else onWidthChange?.(width + (e.key === 'ArrowLeft' ? 32 : -32));
        } else if (e.key === 'Home') {
          e.preventDefault();
          onResetWidth?.();
        }
      }}
      onDoubleClick={onResetWidth}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        resizeCleanup.current?.();
        const start = e.clientX;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        let requested = width;
        // eslint-disable-next-line no-undef
        const move = (event: PointerEvent) => {
          requested = width + start - event.clientX;
          onWidthChange?.(requested, false);
        };
        const cleanup = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', stop);
          target.removeEventListener('pointercancel', stop);
          target.removeEventListener('lostpointercapture', stop);
          resizeCleanup.current = undefined;
        };
        // eslint-disable-next-line no-undef
        const stop = (event: PointerEvent) => {
          cleanup();
          onWidthChange?.(event.type === 'pointerup' ? requested : width);
        };
        resizeCleanup.current = cleanup;
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', stop);
        target.addEventListener('pointercancel', stop);
        target.addEventListener('lostpointercapture', stop);
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-blue-500 group-focus-visible:bg-blue-500',
          resizing && 'bg-blue-500'
        )}
      />
    </div>
  );
}
