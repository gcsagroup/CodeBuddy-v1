import { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import MarkdownContent from './MarkdownContent';
import AnimatedIcons from './AnimatedIcons';
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

function storedPreference(storageKey?: string): boolean | null {
  if (!storageKey || typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(preferenceKey(storageKey));
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return null;
}

const ThinkingContent = memo(function ThinkingContent({
  content,
  isExpanded,
  isStreaming = false,
  storageKey,
}: ThinkingContentProps) {
  const intl = useIntl();
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
  useLayoutEffect(() => {
    if (expanded === targetExpanded) return;
    // Reserve the scroll range before removing body height, not after the
    // browser has already clamped scrollTop during the close animation.
    if (expanded && !targetExpanded && manualToggle === null && header.current) {
      releaseAnchor.current?.();
      releaseAnchor.current = holdLayoutAnchor?.(header.current) ?? null;
    }
    setExpanded(targetExpanded);
  }, [expanded, targetExpanded, manualToggle, holdLayoutAnchor]);
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
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const handleOpenChange = (open: boolean) => {
    setManualToggle(open);
    if (storageKey && typeof window !== 'undefined') {
      window.localStorage.setItem(preferenceKey(storageKey), open ? 'open' : 'closed');
    }
  };
  const updateReadingPosition = () => {
    const element = viewport.current;
    if (!element) return;
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    const selection = window.getSelection();
    const selecting =
      selection?.isCollapsed === false &&
      !!selection.anchorNode &&
      element.contains(selection.anchorNode);
    setRetainReading(!following.current || selecting || !chatFollowing);
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={handleOpenChange}
      className="codepro-thinking-record mb-1 last:mb-0"
    >
      <CollapsibleTrigger
        ref={header}
        className="codepro-record-trigger codepro-secondary-label relative flex min-h-7 items-center gap-1.5 py-1 px-0 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        <span
          aria-hidden="true"
          className={isStreaming ? 'inline-flex h-4 w-4 shrink-0' : 'hidden'}
        >
          {isStreaming && <AnimatedIcons cycleInterval={600} />}
        </span>
        <span>{intl.formatMessage(isStreaming ? i18n.thinkingLive : i18n.thinking)}</span>
        <Expand size={3} isExpanded={expanded} />
      </CollapsibleTrigger>
      <CollapsibleContent className={hasOpened.current ? 'codepro-disclosure-content' : undefined}>
        <div
          ref={viewport}
          onPointerDownCapture={() => {
            following.current = false;
            setRetainReading(true);
          }}
          onPointerUpCapture={updateReadingPosition}
          onFocusCapture={() => setRetainReading(true)}
          onWheelCapture={(event) => {
            if (event.deltaY < 0) {
              following.current = false;
              setRetainReading(true);
            }
          }}
          onScroll={updateReadingPosition}
          className="codepro-operation-details codepro-thinking-details mt-2 w-full min-w-0 border-l-2 border-border-primary pl-4 pr-2 text-sm leading-relaxed text-text-secondary"
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
