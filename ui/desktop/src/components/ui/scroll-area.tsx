/* global Element, WheelEvent, PointerEvent */
import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

type ScrollBehavior = 'auto' | 'smooth';

import { cn } from '../../utils';
import { ScrollFollowingContext, ScrollLayoutAnchorContext } from './scroll-follow-context';

export interface ScrollAreaHandle {
  scrollToBottom: () => void;
  scrollToPosition: (options: { top: number; behavior?: ScrollBehavior }) => void;
  isAtBottom: () => boolean;
  isFollowing: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  autoScroll?: boolean;
  onScrollChange?: (isAtBottom: boolean) => void;
  onBottomChange?: (isAtBottom: boolean) => void;
  /* padding needs to be passed into the container inside ScrollArea to avoid pushing the scrollbar out */
  paddingX?: number;
  paddingY?: number;
  handleScroll?: (viewport: HTMLDivElement) => void;
}

function firstVisibleAnchor(root: Element, top: number, bottom: number): Element | null {
  const stableAnchor = (element: Element) => {
    let anchor = element;
    for (
      let parent = element.parentElement;
      parent && parent !== root;
      parent = parent.parentElement
    ) {
      // An inner scrollbar moves its paragraphs without moving the chat record.
      // Anchor the independent viewport, never content whose offset it owns.
      if (/^(auto|scroll|overlay)$/.test(window.getComputedStyle(parent).overflowY))
        anchor = parent;
    }
    return anchor;
  };
  // Prefer actual reading content over decorative SVG paths at the viewport
  // edge: those icons can stay still while a new history heading moves prose.
  for (const element of Array.from(root.querySelectorAll('p, pre, li, td, th, h1, h2, h3, h4'))) {
    const anchor = stableAnchor(element);
    const rect = anchor.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      (anchor === element
        ? rect.top >= top && rect.bottom <= bottom
        : rect.bottom > top && rect.top < bottom)
    )
      return anchor;
  }
  for (const child of Array.from(root.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0 || rect.bottom <= top || rect.top >= bottom) continue;
    if (/^(auto|scroll|overlay)$/.test(window.getComputedStyle(child).overflowY)) return child;
    if (rect.top >= top && rect.bottom <= bottom) return child;
    const nested = firstVisibleAnchor(child, top, bottom);
    if (nested) return nested;
  }
  return null;
}

const ScrollArea = React.forwardRef<ScrollAreaHandle, ScrollAreaProps>(
  (
    {
      className,
      children,
      autoScroll = false,
      onScrollChange,
      onBottomChange,
      paddingX,
      paddingY,
      handleScroll: handleScrollProp,
      ...props
    },
    ref
  ) => {
    const rootRef = React.useRef<React.ElementRef<typeof ScrollAreaPrimitive.Root>>(null);
    const viewportRef = React.useRef<HTMLDivElement>(null);
    const viewportEndRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const naturalContentRef = React.useRef<HTMLDivElement>(null);
    const lastBottomRef = React.useRef<boolean | null>(null);
    const reportBottom = React.useCallback(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      // Reading mode and visible position are independent. The end marker also
      // excludes temporary whitespace reserved by a collapsing disclosure.
      const end = viewportEndRef.current;
      const distance = end
        ? end.getBoundingClientRect().bottom -
          (viewport.getBoundingClientRect().top + viewport.clientHeight)
        : viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      const atBottom = distance <= 2 && distance >= -viewport.clientHeight;
      if (lastBottomRef.current !== atBottom) {
        lastBottomRef.current = atBottom;
        onBottomChange?.(atBottom);
      }
    }, [onBottomChange]);
    const [isFollowing, setIsFollowing] = React.useState(true);
    const [isScrolled, setIsScrolled] = React.useState(false);
    const userScrolledUpRef = React.useRef(false);
    const followFrame = React.useRef<number | null>(null);
    const followSpeed = React.useRef(0);
    const programmedTop = React.useRef<number | null>(null);
    const isActivelyScrollingRef = React.useRef(false);
    const scrollTimeoutRef = React.useRef<number | null>(null);
    const disclosureAnchorRef = React.useRef<{
      element: Element;
      top: number;
      kind: 'disclosure' | 'reading' | 'layout';
    } | null>(null);

    const stopFollowingMotion = React.useCallback(() => {
      if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
      followFrame.current = null;
      followSpeed.current = 0;
      programmedTop.current = null;
    }, []);

    const followBottom = React.useCallback(() => {
      if (followFrame.current !== null) return;
      let lastAt: number | null = null;
      const tick = (now: number) => {
        const viewport = viewportRef.current;
        if (!viewport || userScrolledUpRef.current || disclosureAnchorRef.current) {
          stopFollowingMotion();
          return;
        }
        const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        if (distance < 1) {
          followFrame.current = null;
          followSpeed.current = 0;
          return;
        }
        const dt = lastAt === null ? 1 / 60 : Math.min(32, now - lastAt) / 1000;
        lastAt = now;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const target = Math.min(480, distance * 8);
        const acceleration = 1800 * dt;
        followSpeed.current += Math.max(
          -acceleration,
          Math.min(acceleration, target - followSpeed.current)
        );
        viewport.scrollTop += reduced
          ? distance
          : Math.min(distance, Math.max(1, followSpeed.current * dt));
        programmedTop.current = viewport.scrollTop;
        followFrame.current = requestAnimationFrame(tick);
      };
      followFrame.current = requestAnimationFrame(tick);
    }, [stopFollowingMotion]);

    React.useEffect(
      () => () => {
        stopFollowingMotion();
        if (scrollTimeoutRef.current !== null) clearTimeout(scrollTimeoutRef.current);
      },
      [stopFollowingMotion]
    );
    React.useEffect(() => {
      if (!autoScroll) stopFollowingMotion();
    }, [autoScroll, stopFollowingMotion]);

    const trackNavigation = React.useCallback(() => {
      isActivelyScrollingRef.current = true;
      if (scrollTimeoutRef.current !== null) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = window.setTimeout(() => {
        isActivelyScrollingRef.current = false;
        scrollTimeoutRef.current = null;
        // The last chunk can arrive during a gesture. Resume without requiring
        // another chunk or resize to wake the existing following animation.
        if (autoScroll && !userScrolledUpRef.current) followBottom();
      }, 100);
    }, [autoScroll, followBottom]);

    const clearDisclosureAnchor = React.useCallback(() => {
      disclosureAnchorRef.current = null;
      if (contentRef.current) contentRef.current.style.minHeight = '';
    }, []);

    const restoreDisclosureAnchor = React.useCallback(() => {
      const anchor = disclosureAnchorRef.current;
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!anchor || !viewport || !content) return false;
      if (!viewport.contains(anchor.element)) {
        clearDisclosureAnchor();
        return false;
      }

      const top = anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const scrollTop = Math.max(0, viewport.scrollTop + top - anchor.top);
      // Collapsing near the end can clamp scrollTop even with auto-follow off.
      // Retain only the space needed to keep the clicked header under the pointer.
      content.style.minHeight = `${Math.ceil(scrollTop + viewport.clientHeight)}px`;
      if (Math.abs(viewport.scrollTop - scrollTop) > 0.5) {
        viewport.scrollTop = scrollTop;
        programmedTop.current = viewport.scrollTop;
      }
      return true;
    }, [clearDisclosureAnchor]);

    const holdLayoutAnchor = React.useCallback(
      (element: Element) => {
        const viewport = viewportRef.current;
        if (!autoScroll || !viewport || !viewport.contains(element) || disclosureAnchorRef.current)
          return () => {};
        stopFollowingMotion();
        const anchor = {
          element,
          top: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
          kind: 'layout' as const,
        };
        disclosureAnchorRef.current = anchor;
        if (contentRef.current)
          contentRef.current.style.minHeight = `${Math.ceil(viewport.scrollTop + viewport.clientHeight)}px`;
        return () => {
          if (disclosureAnchorRef.current !== anchor) return;
          restoreDisclosureAnchor();
          disclosureAnchorRef.current = null;
          // Only a reader needs the old scroll range. Following reserved space
          // after automatic folding can put the entire final answer above view.
          if (!userScrolledUpRef.current) {
            if (contentRef.current) contentRef.current.style.minHeight = '';
            followBottom();
          }
        };
      },
      [autoScroll, followBottom, restoreDisclosureAnchor, stopFollowingMotion]
    );

    const BOTTOM_SCROLL_THRESHOLD = 200;

    const isAtBottom = React.useCallback(() => {
      if (!viewportRef.current) return false;

      const viewport = viewportRef.current;
      const { scrollHeight, scrollTop, clientHeight } = viewport;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      return distanceFromBottom <= BOTTOM_SCROLL_THRESHOLD;
    }, []);

    const scrollToBottom = React.useCallback(() => {
      if (viewportRef.current) {
        stopFollowingMotion();
        clearDisclosureAnchor();
        // Jump instantly rather than animating: a smooth programmatic scroll
        // emits intermediate scroll events that handleScroll mistakes for a
        // manual scroll-up, which disables auto-follow mid-animation.
        viewportRef.current.scrollTo({
          top: viewportRef.current.scrollHeight,
          behavior: 'auto',
        });
        // Its delayed scroll event may arrive after another chunk enlarges the
        // content. Do not mistake that programmatic jump for fresh navigation.
        programmedTop.current = viewportRef.current.scrollTop;
        isActivelyScrollingRef.current = false;
        // When explicitly scrolling to bottom, reset the following state
        setIsFollowing(true);
        userScrolledUpRef.current = false;
        onScrollChange?.(true);
        reportBottom();
      }
    }, [onScrollChange, clearDisclosureAnchor, stopFollowingMotion, reportBottom]);

    const scrollToPosition = React.useCallback(
      ({ top, behavior = 'smooth' }: { top: number; behavior?: ScrollBehavior }) => {
        if (viewportRef.current) {
          stopFollowingMotion();
          clearDisclosureAnchor();
          userScrolledUpRef.current = true;
          setIsFollowing(false);
          onScrollChange?.(false);
          trackNavigation();
          viewportRef.current.scrollTo({
            top,
            behavior,
          });
        }
      },
      [clearDisclosureAnchor, onScrollChange, stopFollowingMotion, trackNavigation]
    );

    // Expose the scroll methods to parent components
    React.useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        scrollToPosition,
        isAtBottom,
        isFollowing,
        viewportRef,
      }),
      [scrollToBottom, scrollToPosition, isAtBottom, isFollowing]
    );

    // track last scroll position to detect user-initiated scrolling
    const lastScrollTopRef = React.useRef(0);

    // Handle scroll events to update isFollowing state
    const handleScroll = React.useCallback(() => {
      if (!viewportRef.current) return;

      const viewport = viewportRef.current;
      reportBottom();
      if (
        programmedTop.current !== null &&
        Math.abs(viewport.scrollTop - programmedTop.current) < 1
      ) {
        lastScrollTopRef.current = viewport.scrollTop;
        setIsScrolled(viewport.scrollTop > 0);
        handleScrollProp?.(viewport);
        return;
      }
      if (disclosureAnchorRef.current && disclosureAnchorRef.current.kind !== 'reading') {
        // Layout-generated scroll events must not resume tail following.
        lastScrollTopRef.current = viewport.scrollTop;
        setIsScrolled(viewport.scrollTop > 0);
        handleScrollProp?.(viewport);
        return;
      }
      if (!isActivelyScrollingRef.current) {
        // Browser anchoring, image loads and layout clamping can emit scroll
        // events too. Only a navigation gesture may change the reader's mode.
        lastScrollTopRef.current = viewport.scrollTop;
        setIsScrolled(viewport.scrollTop > 0);
        handleScrollProp?.(viewport);
        return;
      }
      const { scrollTop } = viewport;
      const movingDown = scrollTop > lastScrollTopRef.current;
      const movingUp = scrollTop < lastScrollTopRef.current;
      if (contentRef.current?.style.minHeight) {
        contentRef.current.style.minHeight = `${Math.ceil(scrollTop + viewport.clientHeight)}px`;
      }
      const currentIsAtBottom = isAtBottom();

      if (scrollTop !== lastScrollTopRef.current) trackNavigation();

      lastScrollTopRef.current = scrollTop;

      // Detect if user manually scrolled up from the bottom
      if (!userScrolledUpRef.current && movingUp) {
        // user scrolled up, disabling auto-scroll
        userScrolledUpRef.current = true;
        setIsFollowing(false);
        onScrollChange?.(false);
      } else if (currentIsAtBottom && userScrolledUpRef.current && movingDown) {
        // user scrolled back to bottom
        userScrolledUpRef.current = false;
        setIsFollowing(true);
        clearDisclosureAnchor();
        onScrollChange?.(true);
      }

      if (autoScroll && userScrolledUpRef.current && contentRef.current) {
        const bounds = viewport.getBoundingClientRect();
        const element = firstVisibleAnchor(contentRef.current, bounds.top, bounds.bottom);
        disclosureAnchorRef.current = element
          ? { element, top: element.getBoundingClientRect().top - bounds.top, kind: 'reading' }
          : null;
      }

      setIsScrolled(scrollTop > 0);

      if (handleScrollProp) {
        handleScrollProp(viewport);
      }
    }, [
      autoScroll,
      isAtBottom,
      onScrollChange,
      handleScrollProp,
      clearDisclosureAnchor,
      trackNavigation,
      reportBottom,
    ]);

    React.useLayoutEffect(() => {
      reportBottom();
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(reportBottom);
      observer.observe(viewport);
      observer.observe(content);
      if (naturalContentRef.current) observer.observe(naturalContentRef.current);
      return () => observer.disconnect();
    }, [reportBottom]);

    // One animation owns both React updates and asynchronous layout growth.
    React.useEffect(() => {
      if (autoScroll && isFollowing && !isActivelyScrollingRef.current) followBottom();
    }, [children, autoScroll, isFollowing, followBottom]);

    React.useEffect(() => {
      if (!autoScroll) return;
      const content = contentRef.current;
      if (!content || typeof ResizeObserver === 'undefined') return;
      let frame: number | undefined;
      const observer = new ResizeObserver(() => {
        // Anchor restoration can resize the observed element. Run it after the
        // observer delivery cycle so layout writes cannot feed that same cycle.
        if (frame !== undefined) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          if (restoreDisclosureAnchor()) return;
          if (isFollowing && !userScrolledUpRef.current && !isActivelyScrollingRef.current) {
            followBottom();
          }
        });
      });
      observer.observe(content);
      // Reserved reading space can keep the outer box unchanged while a folded
      // or removed child disappears. Its natural size must also wake restoration.
      if (naturalContentRef.current) observer.observe(naturalContentRef.current);
      return () => {
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
      };
    }, [autoScroll, isFollowing, restoreDisclosureAnchor, followBottom]);

    // Add scroll event listener
    React.useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      // Reading an expanded operation must win over automatic tail following.
      // Do not cancel the wheel: nested native scrollers must retain scroll chaining.
      const pauseFollowing = () => {
        stopFollowingMotion();
        userScrolledUpRef.current = true;
        setIsFollowing(false);
        onScrollChange?.(false);
      };
      const handleWheel = (event: WheelEvent) => {
        // A real navigation gesture ends anchoring. Keep existing space until it
        // can be trimmed without clamping the user's current scroll position.
        disclosureAnchorRef.current = null;
        stopFollowingMotion();
        trackNavigation();
        if (event.deltaY < 0) pauseFollowing();
      };
      const handleDisclosure = (event: Event) => {
        const target = event.target;
        const control =
          target instanceof Element ? target.closest('summary, [aria-expanded]') : null;
        // A bottom "show more" control moves when rows appear above it.
        // Anchor the stable section heading instead of following that button.
        const element =
          control
            ?.closest('[data-disclosure-anchor]')
            ?.querySelector('[data-disclosure-heading]') ?? control;
        if (autoScroll && element && viewport.contains(element)) {
          disclosureAnchorRef.current = {
            element,
            top: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
            kind: 'disclosure',
          };
          // Reserve the scroll range before the default click action changes
          // layout. A ResizeObserver correction alone is one frame too late.
          if (contentRef.current) {
            contentRef.current.style.minHeight = `${Math.ceil(viewport.scrollTop + viewport.clientHeight)}px`;
          }
          pauseFollowing();
        }
      };
      const handleNavigationKey = (event: KeyboardEvent) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('input, textarea, [contenteditable="true"]')
          )
            return;
          disclosureAnchorRef.current = null;
          stopFollowingMotion();
          trackNavigation();
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollowing();
        }
      };
      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target;
        stopFollowingMotion();
        trackNavigation();
        // Keep an established reading anchor until actual navigation updates it.
        // A focus click by itself need not change the reader's position.
        if (
          disclosureAnchorRef.current?.kind === 'disclosure' &&
          (!(target instanceof Element) || !target.closest('summary, [aria-expanded]'))
        ) {
          disclosureAnchorRef.current = null;
        }
      };
      const handlePointerMove = (event: PointerEvent) => {
        if (event.buttons || event.pointerType === 'touch') {
          trackNavigation();
          if (window.getSelection()?.isCollapsed === false) pauseFollowing();
        }
      };
      const root = rootRef.current;

      viewport.addEventListener('scroll', handleScroll, { passive: true });
      viewport.addEventListener('wheel', handleWheel, { passive: true });
      viewport.addEventListener('click', handleDisclosure, true);
      viewport.addEventListener('keydown', handleNavigationKey);
      root?.addEventListener('pointerdown', handlePointerDown, true);
      root?.addEventListener('pointermove', handlePointerMove, { passive: true });
      return () => {
        viewport.removeEventListener('scroll', handleScroll);
        viewport.removeEventListener('wheel', handleWheel);
        viewport.removeEventListener('click', handleDisclosure, true);
        viewport.removeEventListener('keydown', handleNavigationKey);
        root?.removeEventListener('pointerdown', handlePointerDown, true);
        root?.removeEventListener('pointermove', handlePointerMove);
      };
    }, [autoScroll, handleScroll, onScrollChange, stopFollowingMotion, trackNavigation]);

    return (
      <ScrollAreaPrimitive.Root
        ref={rootRef}
        className={cn('relative overflow-hidden', className)}
        data-scrolled={isScrolled}
        {...props}
      >
        <div className={cn('absolute top-0 left-0 right-0 z-10 transition-all duration-200')} />
        <ScrollAreaPrimitive.Viewport
          ref={viewportRef}
          className="h-full w-full rounded-[inherit] [&>div]:!block"
        >
          <div
            ref={contentRef}
            className={cn(paddingX ? `px-${paddingX}` : '', paddingY ? `py-${paddingY}` : '')}
          >
            <div ref={naturalContentRef}>
              <ScrollFollowingContext.Provider value={!autoScroll || isFollowing}>
                <ScrollLayoutAnchorContext.Provider value={holdLayoutAnchor}>
                  {children}
                </ScrollLayoutAnchorContext.Provider>
              </ScrollFollowingContext.Provider>
              {autoScroll && <div ref={viewportEndRef} style={{ height: '1px' }} />}
            </div>
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    );
  }
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
      orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border-primary dark:bg-background-secondary" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
