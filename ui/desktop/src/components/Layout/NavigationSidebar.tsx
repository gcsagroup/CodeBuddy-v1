import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useIntl } from '../../i18n';
import { NAV_DIMENSIONS } from './constants';
import { cn } from '../../utils';

const WIDTH_KEY = 'navigation_width';
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const COLLAPSE_THRESHOLD = 120;

export function NavigationSidebar({
  expanded,
  onExpandedChange,
  children,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const intl = useIntl();
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
    } catch {
      /* Width is optional when storage is unavailable. */
    }
    return NAV_DIMENSIONS.NAV_WIDTH;
  });
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number; preview: number } | null>(
    null
  );
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - 360));
  const visibleWidth = Math.min(width, maxWidth);
  const resizeLabel = intl.formatMessage({
    id: 'appLayout.resizeNavigation',
    defaultMessage: 'Resize sidebar',
  });

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const rememberWidth = (value: number) => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(value));
    } catch {
      /* Optional preference. */
    }
  };
  const updateWidth = (value: number, remember = false) => {
    const next = Math.max(MIN_WIDTH, Math.min(maxWidth, value));
    setWidth(next);
    if (remember) rememberWidth(next);
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const nextWidth = drag.current.preview;
    drag.current = null;
    setResizing(false);
    setDragWidth(null);
    if (event.type === 'pointerup') {
      if (nextWidth === 0) onExpandedChange(false);
      else updateWidth(nextWidth, true);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: expanded ? (dragWidth ?? visibleWidth) : 0 }}
      transition={{ duration: resizing || reducedMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="relative h-full shrink-0 overflow-hidden"
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div className="h-full" style={{ width: dragWidth || visibleWidth }}>
        <div className="h-full overflow-hidden border-r border-border-secondary">{children}</div>
      </div>
      {expanded && (
        <div
          role="separator"
          aria-label={resizeLabel}
          title={resizeLabel}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(dragWidth ?? visibleWidth)}
          tabIndex={0}
          className={cn(
            'no-drag group absolute inset-y-0 right-0 z-[101] w-1.5 cursor-col-resize touch-none outline-none'
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              width: visibleWidth,
              preview: visibleWidth,
            };
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointerId === event.pointerId) {
              const next = drag.current.width + event.clientX - drag.current.x;
              const preview =
                next < COLLAPSE_THRESHOLD ? 0 : Math.max(MIN_WIDTH, Math.min(maxWidth, next));
              drag.current.preview = preview;
              setDragWidth(preview);
            }
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onDoubleClick={() => updateWidth(NAV_DIMENSIONS.NAV_WIDTH, true)}
          onKeyDown={(event) => {
            if (event.key === 'Home') {
              event.preventDefault();
              updateWidth(NAV_DIMENSIONS.NAV_WIDTH, true);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              if (event.key === 'ArrowLeft' && visibleWidth <= MIN_WIDTH) onExpandedChange(false);
              else updateWidth(visibleWidth + (event.key === 'ArrowRight' ? 16 : -16), true);
            }
          }}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-blue-500 group-focus-visible:bg-blue-500',
              resizing && 'bg-blue-500'
            )}
          />
        </div>
      )}
    </motion.aside>
  );
}
