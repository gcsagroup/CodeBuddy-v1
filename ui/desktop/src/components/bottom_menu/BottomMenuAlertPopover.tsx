import { AppEvents } from '../../constants/events';
import React, { useRef, useEffect, useLayoutEffect, useCallback, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaCircle } from 'react-icons/fa';
import { cn } from '../../utils';
import { Alert, AlertType } from '../alerts';
import { AlertBox } from '../alerts';

const focusableAction = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]';

interface AlertPopoverProps {
  alerts: Alert[];
  children?: React.ReactNode;
  triggerLabel?: string;
  triggerDescription?: string;
  triggerClassName?: string;
  showIndicator?: boolean;
  preview?: React.ReactNode;
}

export default function BottomMenuAlertPopover({
  alerts,
  children,
  triggerLabel,
  triggerDescription,
  triggerClassName,
  showIndicator = true,
  preview,
}: AlertPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const shouldShowIndicator = alerts.length > 0;
  const hasContent = shouldShowIndicator || Boolean(preview);
  const pinned = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retain = () => clearTimeout(hoverTimer.current);
  const leave = () => {
    if (!preview || pinned.current) return;
    retain();
    hoverTimer.current = setTimeout(() => setIsOpen(false), 180);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Calculate popover position
  const calculatePosition = useCallback(() => {
    if (!triggerRef.current || !popoverRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = popoverRef.current.offsetWidth;

    // Get the actual rendered height of the popover
    const popoverHeight = popoverRef.current.offsetHeight || 120;
    const offset = 8; // Small gap to avoid blocking the trigger dot

    // Position above the trigger, centered horizontally
    let top = triggerRect.top - popoverHeight - offset;
    let left = triggerRect.left + triggerRect.width / 2 - popoverWidth / 2;

    // Ensure popover doesn't go off-screen
    const viewportWidth = window.innerWidth;

    // Adjust horizontal position if off-screen
    if (left < 10) {
      left = 10;
    } else if (left + popoverWidth > viewportWidth - 10) {
      left = viewportWidth - popoverWidth - 10;
    }

    // If popover would go above viewport, show it below the trigger instead
    if (top < 10) {
      top = triggerRect.bottom + offset;
    }

    setPopoverPosition({ top, left });
  }, []);

  // Update position when popover opens
  useLayoutEffect(() => {
    if (isOpen) {
      calculatePosition();
      const handleResize = () => calculatePosition();
      const observer =
        typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(handleResize);
      if (popoverRef.current) observer?.observe(popoverRef.current);
      window.addEventListener('resize', handleResize);
      window.addEventListener('scroll', handleResize, true);
      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('scroll', handleResize, true);
        observer?.disconnect();
      };
    }
    return undefined;
  }, [isOpen, calculatePosition]);

  // Moving between the trigger and action must not dismiss a clicked popover.
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        pinned.current = false;
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pinned.current = false;
        triggerRef.current?.focus();
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('pointerdown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Listen for custom event to hide the popover
  useEffect(() => {
    const handleHidePopover = () => {
      if (isOpen) {
        pinned.current = false;
        setIsOpen(false);
      }
    };

    window.addEventListener(AppEvents.HIDE_ALERT_POPOVER, handleHidePopover);
    return () => {
      window.removeEventListener(AppEvents.HIDE_ALERT_POPOVER, handleHidePopover);
    };
  }, [isOpen]);

  // Use shouldShowIndicator instead of alerts.length for rendering decision
  if (!shouldShowIndicator && !children) {
    return null;
  }

  // Determine the icon and styling based on the alerts (use current alerts if available, or default to info)
  const hasError = alerts.some((alert) => alert.type === AlertType.Error);
  const hasInfo = alerts.some((alert) => alert.type === AlertType.Info);
  const triggerColor = hasError
    ? 'text-[#d7040e]' // Red color for error alerts
    : hasInfo || alerts.length === 0 // Default to green for context info when no alerts
      ? 'text-[#00b300]' // Green color for info alerts
      : 'text-[#cc4b03]'; // Orange color for warning alerts

  const trigger = (
    <button
      type="button"
      ref={triggerRef}
      id={`${popoverId}-trigger`}
      aria-label={triggerLabel}
      aria-description={triggerDescription}
      aria-expanded={isOpen && hasContent}
      aria-controls={isOpen && hasContent ? popoverId : undefined}
      aria-haspopup={hasContent ? 'dialog' : undefined}
      className={cn(
        'group/context-usage cursor-pointer flex items-center gap-1.5 min-h-5 rounded px-1',
        triggerClassName
      )}
      onClick={() => {
        if (!hasContent) return;
        if (preview) {
          const next = !pinned.current || !isOpen;
          pinned.current = next;
          setIsOpen(next);
        } else setIsOpen((open) => !open);
      }}
      onMouseEnter={() => {
        retain();
        if (preview) setIsOpen(true);
      }}
      onMouseLeave={leave}
      onFocus={() => {
        if (preview) setIsOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.shiftKey || !isOpen) return;
        // The body portal is outside the trigger's natural tab order.
        const action = popoverRef.current?.querySelector<HTMLElement>(focusableAction);
        if (action) {
          event.preventDefault();
          action.focus();
        }
      }}
      onBlur={(event) => {
        if (preview && !popoverRef.current?.contains(event.relatedTarget)) {
          pinned.current = false;
          setIsOpen(false);
        }
      }}
    >
      {showIndicator && shouldShowIndicator && (
        <div className={cn('relative', triggerColor)}>
          <FaCircle size={5} />
        </div>
      )}
      {children}
    </button>
  );

  return (
    <>
      <div className="relative">{trigger}</div>

      {/* Popover rendered separately to avoid blocking clicks */}
      {isOpen &&
        hasContent &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-labelledby={`${popoverId}-trigger`}
            onMouseEnter={retain}
            onMouseLeave={leave}
            onKeyDown={(event) => {
              if (
                event.key === 'Tab' && event.shiftKey &&
                document.activeElement === popoverRef.current?.querySelector(focusableAction)
              ) {
                event.preventDefault();
                triggerRef.current?.focus();
              }
            }}
            onBlur={(event) => {
              if (
                preview &&
                !popoverRef.current?.contains(event.relatedTarget) &&
                !triggerRef.current?.contains(event.relatedTarget)
              ) {
                pinned.current = false;
                setIsOpen(false);
              }
            }}
            className={cn(
              'fixed p-0 rounded-lg overflow-hidden z-[100] shadow-lg pointer-events-auto text-left',
              preview
                ? 'w-44 max-w-[calc(100vw-1.5rem)] bg-background-secondary text-text-secondary'
                : alerts.every((alert) => alert.progress)
                  ? 'w-max min-w-24 max-w-48 border bg-background-primary'
                  : 'w-[275px] border bg-background-primary'
            )}
            style={{
              top: `${popoverPosition.top}px`,
              left: `${popoverPosition.left}px`,
              visibility: popoverPosition.top === 0 ? 'hidden' : 'visible',
            }}
          >
            <div className="flex flex-col">
              {preview && (
                <div className="bg-background-secondary px-3 py-2.5 text-center text-xs text-text-secondary">
                  {preview}
                </div>
              )}
              {alerts.map((alert, index) => (
                <div key={index} className={cn(index > 0 && 'border-t border-white/20')}>
                  <AlertBox alert={alert} />
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
