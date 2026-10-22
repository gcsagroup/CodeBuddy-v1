import { AppEvents } from '../../constants/events';
import React, { useRef, useEffect, useCallback, useId, useState } from 'react';
import { FaCircle } from 'react-icons/fa';
import { cn } from '../../utils';
import { Alert, AlertType } from '../alerts';
import { AlertBox } from '../alerts';

interface AlertPopoverProps {
  alerts: Alert[];
  children?: React.ReactNode;
}

export default function BottomMenuAlertPopover({ alerts, children }: AlertPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const shouldShowIndicator = alerts.length > 0;
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
  useEffect(() => {
    if (isOpen) {
      calculatePosition();
      // Recalculate on window resize
      const handleResize = () => calculatePosition();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
    return undefined;
  }, [isOpen, calculatePosition]);

  // Recalculate position after popover is rendered to get actual height
  useEffect(() => {
    if (isOpen && popoverRef.current) {
      // Small delay to ensure DOM is updated
      const timer = setTimeout(() => {
        calculatePosition();
      }, 10);
      return () => clearTimeout(timer);
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
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
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

  return (
    <>
      <div className="relative">
        <button
          type="button"
          ref={triggerRef}
          id={`${popoverId}-trigger`}
          aria-expanded={isOpen && shouldShowIndicator}
          aria-controls={isOpen && shouldShowIndicator ? popoverId : undefined}
          aria-haspopup="dialog"
          className="group/context-usage cursor-pointer flex items-center gap-1.5 min-h-5 rounded px-1"
          onClick={() => {
            if (alerts.length > 0) setIsOpen((open) => !open);
          }}
        >
          {shouldShowIndicator && (
            <div className={cn('relative', triggerColor)}>
              <FaCircle size={5} />
            </div>
          )}
          {children}
        </button>
      </div>

      {/* Popover rendered separately to avoid blocking clicks */}
      {isOpen && shouldShowIndicator && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-labelledby={`${popoverId}-trigger`}
          className={cn(
            'fixed p-0 rounded-lg overflow-hidden bg-app border z-50 shadow-lg pointer-events-auto text-left',
            alerts.every((alert) => alert.progress) ? 'w-max min-w-24 max-w-48' : 'w-[275px]'
          )}
          style={{
            top: `${popoverPosition.top}px`,
            left: `${popoverPosition.left}px`,
            visibility: popoverPosition.top === 0 ? 'hidden' : 'visible',
          }}
        >
          <div className="flex flex-col">
            {alerts.map((alert, index) => (
              <div key={index} className={cn(index > 0 && 'border-t border-white/20')}>
                <AlertBox alert={alert} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
