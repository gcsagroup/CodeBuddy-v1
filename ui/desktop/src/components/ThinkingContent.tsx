import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
    defaultMessage: 'Thinking · Updating',
  },
  latest: { id: 'thinkingContent.latest', defaultMessage: 'Back to latest' },
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

export default function ThinkingContent({
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
  // A default-open thought may close at its boundary, but not under a reader.
  // This affects disclosure only; source events continue to arrive unchanged.
  useLayoutEffect(() => {
    if (isExpanded && !chatFollowing) setRetainReading(true);
  }, [isExpanded, chatFollowing]);
  const targetExpanded = manualToggle !== null ? manualToggle : isExpanded || retainReading;
  const [expanded, setExpanded] = useState(targetExpanded);
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
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useLayoutEffect(() => {
    if (expanded && following.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [content, expanded]);
  const handleOpenChange = (open: boolean) => {
    setManualToggle(open);
    if (storageKey && typeof window !== 'undefined') {
      window.localStorage.setItem(preferenceKey(storageKey), open ? 'open' : 'closed');
    }
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
      <CollapsibleContent className="codepro-disclosure-content">
        <div
          ref={viewport}
          onPointerDownCapture={() => setRetainReading(true)}
          onFocusCapture={() => setRetainReading(true)}
          onWheelCapture={(event) => {
            if (event.deltaY < 0) setRetainReading(true);
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
            setAwayFromLatest(!following.current);
            if (!following.current) setRetainReading(true);
          }}
          className="codepro-operation-details codepro-thinking-details mt-2 max-h-72 max-w-[42rem] overflow-y-auto overscroll-contain text-sm leading-relaxed text-text-secondary"
        >
          <MarkdownContent content={content} animateIncoming={isStreaming} />
        </div>
        {awayFromLatest && (
          <button
            type="button"
            className="mt-1 text-xs text-text-secondary hover:text-text-primary"
            onClick={() => {
              following.current = true;
              setAwayFromLatest(false);
              if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
            }}
          >
            {intl.formatMessage(i18n.latest)}
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
