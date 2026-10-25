import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../utils';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { ScrollFollowingContext } from './ui/scroll-follow-context';

export interface ToolCallExpandableProps {
  compact?: boolean;
  label: ReactNode;
  // Interactive controls are siblings of the disclosure buttons, never nested buttons.
  headerAction?: ReactNode;
  headerSuffix?: ReactNode;
  icon?: ReactNode;
  accessibleName?: string;
  isStartExpanded?: boolean;
  isForceExpand?: boolean;
  children: ReactNode;
  className?: string;
  storageKey?: string;
  groupHeading?: boolean;
  contentClassName?: string;
  scrollable?: boolean;
  // Keep the same content parent while live work becomes collapsible history.
  collapsible?: boolean;
  collapseOnSettle?: boolean;
}

function readExpansion(key?: string): boolean | null {
  if (!key) return null;
  try {
    const value = window.sessionStorage.getItem(`codepro-operation:${key}`);
    return value === 'open' ? true : value === 'closed' ? false : null;
  } catch {
    return null;
  }
}

export function ToolCallExpandable({
  compact = false,
  label,
  headerAction,
  headerSuffix,
  icon,
  accessibleName,
  isStartExpanded = false,
  isForceExpand,
  children,
  className = '',
  storageKey,
  groupHeading = false,
  contentClassName,
  scrollable = true,
  collapsible = true,
  collapseOnSettle = false,
}: ToolCallExpandableProps) {
  const [expandedState, setExpanded] = useState<boolean | null>(() => readExpansion(storageKey));
  const expanded = !collapsible || (expandedState === null ? isStartExpanded : expandedState);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const chatFollowing = useContext(ScrollFollowingContext);
  const wasSettled = useRef(collapseOnSettle);

  useEffect(() => {
    if (collapseOnSettle && !wasSettled.current && chatFollowing && expandedState !== true) {
      setExpanded(false);
      if (storageKey) {
        try {
          window.sessionStorage.setItem(`codepro-operation:${storageKey}`, 'closed');
        } catch {
          /* Storage is optional. */
        }
      }
    }
    wasSettled.current = collapseOnSettle;
  }, [collapseOnSettle, storageKey, chatFollowing, expandedState]);

  useEffect(() => {
    // Scrollbar dragging and keyboard navigation need not reach this element.
    // Consume the scroll owner's choice instead of detecting those gestures again.
    if (!collapsible && !chatFollowing) setExpanded(true);
  }, [chatFollowing, collapsible]);
  const retainReading = () => {
    // Reading live details is an explicit choice, not permission to hide them
    // when the next public block or answer arrives. Do not persist automatic state.
    if (!collapsible) setExpanded(true);
  };
  const retainReadingFromInteraction = (event: SyntheticEvent) => {
    // Approving a tool is part of execution, not a request to keep its history open.
    if (
      event.target instanceof window.Element &&
      event.target.closest('[data-tool-approval-actions]')
    ) {
      return;
    }
    retainReading();
  };

  useLayoutEffect(() => {
    // A growing live group stays at its latest operation unless the user is reading above.
    if (scrollable && !collapsible && following.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [children, collapsible, scrollable]);

  useEffect(() => {
    if (isForceExpand) setExpanded(true);
  }, [isForceExpand]);

  return (
    <Collapsible
      className={className}
      data-live-operations={compact && groupHeading && !collapsible ? '' : undefined}
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        if (storageKey) {
          try {
            window.sessionStorage.setItem(
              `codepro-operation:${storageKey}`,
              open ? 'open' : 'closed'
            );
          } catch {
            /* Storage is optional; in-memory expansion still works. */
          }
        }
      }}
    >
      {collapsible && (
        <div
          className={
            headerAction ? cn('flex min-w-0 items-center', compact && 'gap-1.5') : undefined
          }
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              className={cn(
                'group w-full flex justify-start gap-1.5 items-center pr-2 transition-colors rounded-[10px] text-left hover:bg-transparent dark:hover:bg-transparent hover:text-text-primary',
                compact && 'codepro-record-trigger relative h-auto min-h-7 py-1 !px-0',
                headerAction && 'w-auto shrink-0'
              )}
              variant="ghost"
              aria-expanded={expanded}
              aria-label={accessibleName}
            >
              {compact && icon && (
                <span
                  className="codepro-record-icon flex w-[18px] shrink-0 items-center justify-start"
                  aria-hidden="true"
                >
                  {icon}
                </span>
              )}
              <span
                className={cn(
                  'flex items-center font-sans text-sm truncate min-w-0',
                  compact && (groupHeading ? 'codepro-group-heading' : 'codepro-secondary-label')
                )}
              >
                {label}
              </span>
              {!headerAction && (
                <ChevronRight
                  className={cn(
                    'group-hover:opacity-100 transition-transform opacity-70',
                    expanded && 'rotate-90'
                  )}
                  aria-hidden="true"
                />
              )}
            </Button>
          </CollapsibleTrigger>
          {headerAction && (
            <>
              {headerAction}
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={-1}
                  aria-hidden="true"
                  className={cn(
                    'group flex h-auto min-h-7 min-w-5 items-center gap-1.5 rounded-[10px] py-1 hover:bg-transparent',
                    compact ? 'shrink-0 justify-start !px-0' : 'flex-1 justify-end px-1'
                  )}
                >
                  {headerSuffix}
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 shrink-0 opacity-70 transition-transform',
                      expanded && 'rotate-90'
                    )}
                  />
                </Button>
              </CollapsibleTrigger>
            </>
          )}
        </div>
      )}
      <CollapsibleContent
        className={cn(
          compact && groupHeading && 'codepro-auto-disclosure',
          collapsible && expandedState !== null && 'codepro-disclosure-content'
        )}
      >
        <div
          ref={viewport}
          tabIndex={compact && scrollable ? 0 : undefined}
          onPointerDownCapture={retainReadingFromInteraction}
          onFocusCapture={retainReadingFromInteraction}
          onWheelCapture={(event) => {
            if (event.deltaY < 0) retainReading();
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
          }}
          className={cn(
            compact && 'codepro-operation-details',
            compact &&
              scrollable &&
              'my-1 max-h-80 overflow-y-auto overscroll-contain rounded-lg border border-border-primary bg-background-secondary/40 px-3 py-2 [scrollbar-width:thin] focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-primary',
            contentClassName
          )}
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
