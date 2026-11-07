import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Atom } from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import Expand from './ui/Expand';
import { defineMessages, useIntl } from '../i18n';
import { ScrollFollowingContext, ScrollLayoutAnchorContext } from './ui/scroll-follow-context';

const i18n = defineMessages({
  thinking: {
    id: 'thinkingContent.thinking',
    defaultMessage: 'Thinking',
  },
  thinkingLive: {
    id: 'thinkingContent.thinkingLive',
    defaultMessage: 'Thinking (updating)',
  },
});

interface ThinkingContentProps {
  content: string;
  isExpanded: boolean;
  isStreaming?: boolean;
  storageKey?: string;
}

const preferenceKey = (storageKey: string) => `codepro-thinking:${storageKey}`;

function thinkingPreview(content: string, streaming: boolean): string {
  const firstLine = content.trimStart().split(/\r?\n/, 1)[0];
  let line = firstLine;
  if (streaming) {
    const paragraphs = /\r?\n(?:[\t ]*\r?\n)+/g;
    let start = 0;
    // Follow DSH's paragraph-first-line preview, keeping the previous line
    // until a new one is complete. The first partial line is the fallback.
    while (true) {
      const boundary = paragraphs.exec(content);
      const end = boundary ? boundary.index + boundary[0].indexOf('\n') : content.length;
      const newline = content.indexOf('\n', start);
      if (newline !== -1 && newline <= end) {
        const candidate = content.slice(start, newline).trim();
        if (candidate) line = candidate;
      }
      if (!boundary) break;
      start = boundary.index + boundary[0].length;
    }
  }
  let preview = '';
  for (const character of line.replace(/\*\*/g, '').trim()) {
    // Keep very long single-line thoughts out of the collapsed DOM.
    if (preview.length + character.length > 240) return `${preview}…`;
    preview += character;
  }
  return preview;
}

function storedPreference(storageKey?: string): boolean | null {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(preferenceKey(storageKey));
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    /* Storage is optional. */
  }
  return null;
}

function storedReadingOffset(storageKey?: string): number {
  if (!storageKey || typeof window === 'undefined') return 0;
  try {
    const offset = Number(window.sessionStorage.getItem(`${preferenceKey(storageKey)}:position`));
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
  } catch {
    return 0;
  }
}

const ThinkingContent = memo(function ThinkingContent({
  content,
  isExpanded,
  isStreaming = false,
  storageKey,
}: ThinkingContentProps) {
  const intl = useIntl();
  const label = intl.formatMessage(isStreaming ? i18n.thinkingLive : i18n.thinking);
  const preview = useMemo(() => thinkingPreview(content, isStreaming), [content, isStreaming]);
  const [manualToggle, setManualToggle] = useState<boolean | null>(() =>
    storedPreference(storageKey)
  );
  const chatFollowing = useContext(ScrollFollowingContext);
  const [retainReading, setRetainReading] = useState(false);
  const [idleFold, setIdleFold] = useState(false);
  useEffect(() => {
    setIdleFold(false);
    if (!isExpanded || !isStreaming || !content.trim()) return;
    // Disclosure only: silence is not evidence of a completed model phase.
    // Tool arguments can still be streaming before their native call is ready.
    const timer = window.setTimeout(() => setIdleFold(true), 2500);
    return () => window.clearTimeout(timer);
  }, [content, isExpanded, isStreaming]);
  // A default-open thought may close at its boundary, but not under a reader.
  // This affects disclosure only; source events continue to arrive unchanged.
  useLayoutEffect(() => {
    if (isExpanded && !chatFollowing) setRetainReading(true);
  }, [isExpanded, chatFollowing]);
  const targetExpanded =
    manualToggle !== null ? manualToggle : (isExpanded && !idleFold) || retainReading;
  const [expanded, setExpanded] = useState(targetExpanded);
  const hasOpened = useRef(expanded);
  if (expanded) hasOpened.current = true;
  const header = useRef<HTMLButtonElement>(null);
  const holdLayoutAnchor = useContext(ScrollLayoutAnchorContext);
  const releaseAnchor = useRef<(() => void) | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const readingOffset = useRef(storedReadingOffset(storageKey));
  const resumeReading = useRef(false);
  const readingViewport = useCallback(
    () =>
      header.current?.closest<HTMLElement>(
        '.codepro-process-details, [data-radix-scroll-area-viewport]'
      ),
    []
  );
  const processAnchor = useRef<{ viewport: HTMLElement; offset: number } | null>(null);
  const captureProcessAnchor = useCallback(() => {
    const viewport = header.current?.closest<HTMLElement>('.codepro-process-details');
    processAnchor.current =
      header.current && viewport
        ? {
            viewport,
            offset:
              header.current.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
          }
        : null;
  }, []);
  useLayoutEffect(() => {
    if (expanded === targetExpanded) return;
    // Reserve the scroll range before removing body height, not after the
    // browser has already clamped scrollTop during the close animation.
    if (expanded && !targetExpanded && manualToggle === null && header.current) {
      captureProcessAnchor();
      releaseAnchor.current?.();
      releaseAnchor.current = holdLayoutAnchor?.(header.current) ?? null;
    }
    setExpanded(targetExpanded);
  }, [expanded, targetExpanded, manualToggle, holdLayoutAnchor, captureProcessAnchor]);
  useLayoutEffect(() => {
    if (
      expanded &&
      expanded === targetExpanded &&
      resumeReading.current &&
      body.current &&
      header.current
    ) {
      resumeReading.current = false;
      processAnchor.current = null;
      const viewport = readingViewport();
      if (!viewport) return;
      const offset = Math.min(readingOffset.current, Math.max(0, body.current.scrollHeight - 1));
      const top = header.current.getBoundingClientRect().height - offset;
      const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';
      if (viewport.matches('[data-radix-scroll-area-viewport]') && holdLayoutAnchor) {
        holdLayoutAnchor(body.current, { top, behavior });
      } else {
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            body.current.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            top,
          behavior,
        });
      }
      return;
    }
    const anchor = processAnchor.current;
    if (!anchor || !header.current || expanded !== targetExpanded) return;
    const offset =
      header.current.getBoundingClientRect().top - anchor.viewport.getBoundingClientRect().top;
    anchor.viewport.scrollTop += offset - anchor.offset;
    processAnchor.current = null;
  }, [expanded, targetExpanded, holdLayoutAnchor, readingViewport]);
  useEffect(() => {
    if (expanded || !releaseAnchor.current) return;
    const release = () => {
      releaseAnchor.current?.();
      releaseAnchor.current = null;
    };
    // Also release when reduced motion disables animation events, or unmounts.
    const timer = window.setTimeout(release, 320);
    return () => {
      window.clearTimeout(timer);
      release();
    };
  }, [expanded]);
  const handleOpenChange = (open: boolean) => {
    captureProcessAnchor();
    if (!open && body.current && header.current) {
      const viewport = readingViewport();
      if (viewport) {
        readingOffset.current = Math.max(
          0,
          viewport.getBoundingClientRect().top +
            header.current.getBoundingClientRect().height -
            body.current.getBoundingClientRect().top
        );
        if (storageKey) {
          try {
            window.sessionStorage.setItem(
              `${preferenceKey(storageKey)}:position`,
              String(readingOffset.current)
            );
          } catch {
            /* Storage is optional. */
          }
        }
      }
    }
    resumeReading.current = open && readingOffset.current > 0;
    if (!open && header.current) {
      releaseAnchor.current?.();
      releaseAnchor.current = holdLayoutAnchor?.(header.current) ?? null;
    }
    setManualToggle(open);
    if (storageKey && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(preferenceKey(storageKey), open ? 'open' : 'closed');
      } catch {
        /* Storage is optional. */
      }
    }
  };
  const updateReadingPosition = () => {
    const element = body.current;
    if (!element) return;
    const selection = window.getSelection();
    const selecting =
      selection?.isCollapsed === false &&
      !!selection.anchorNode &&
      element.contains(selection.anchorNode);
    if (selecting || !chatFollowing) setRetainReading(true);
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={handleOpenChange}
      className="codepro-thinking-record mb-1 min-w-0 max-w-full last:mb-0"
    >
      <CollapsibleTrigger
        ref={header}
        aria-label={label}
        className="codepro-thinking-header codepro-record-trigger codepro-secondary-label flex min-h-7 w-full min-w-0 items-center gap-1.5 py-1 px-0 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        <span
          aria-hidden="true"
          className="codepro-record-icon flex w-[18px] shrink-0 items-center justify-start"
        >
          <Atom
            size={16}
            strokeWidth={1.5}
            className={isStreaming ? 'motion-safe:animate-spin' : undefined}
          />
        </span>
        <span className="shrink-0">{label}</span>
        <span className="inline-flex shrink-0">
          <Expand size={3} isExpanded={expanded} />
        </span>
        {!expanded && preview && (
          <span aria-hidden="true" className="codepro-thinking-preview min-w-0 truncate text-left">
            {preview}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent
        className={
          hasOpened.current ? 'codepro-disclosure-content codepro-thinking-disclosure' : undefined
        }
      >
        <div
          ref={body}
          onPointerDownCapture={() => {
            setRetainReading(true);
          }}
          onPointerUpCapture={updateReadingPosition}
          onFocusCapture={() => setRetainReading(true)}
          onWheelCapture={(event) => {
            if (event.deltaY < 0) {
              setRetainReading(true);
            }
          }}
          className="codepro-operation-details codepro-thinking-details mt-1 w-full min-w-0 pl-6 text-sm text-text-secondary"
        >
          {/* Source chunks already stream; per-word animation nodes make long thoughts costly. */}
          <MarkdownContent
            content={content}
            className="!text-text-secondary prose-headings:text-text-secondary prose-strong:text-text-secondary prose-a:text-text-secondary"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

export default ThinkingContent;
