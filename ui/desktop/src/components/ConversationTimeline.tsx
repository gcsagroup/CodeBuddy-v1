import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { defineMessages, useIntl } from '../i18n';
import { getTextAndImageContent, getToolResponses, type Message } from '../types/message';
import type { ScrollAreaHandle } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';
import './conversationTimeline.css';

const labels = defineMessages({
  navigation: { id: 'conversationTimeline.navigation', defaultMessage: 'Conversation timeline' },
  turn: { id: 'conversationTimeline.turn', defaultMessage: 'Go to turn {number}: {text}' },
  attachment: { id: 'conversationTimeline.attachment', defaultMessage: 'Attachment message' },
  noReply: { id: 'conversationTimeline.noReply', defaultMessage: 'No reply yet' },
});

export function ConversationTimeline({
  messages,
  scrollRef,
  onNavigate,
}: {
  messages: Message[];
  scrollRef: RefObject<ScrollAreaHandle | null>;
  onNavigate: (messageId: string) => void;
}) {
  const intl = useIntl();
  const railRef = useRef<HTMLElement>(null);
  const currentTickRef = useRef<HTMLButtonElement>(null);
  const [visibility, setVisibility] = useState<{ firstVisibleId?: string; visible: string[] }>({
    visible: [],
  });
  const turns = useMemo(() => {
    const result: Array<{ id: string; question: string; answer: string }> = [];
    for (const message of messages) {
      if (!message.metadata.userVisible) continue;
      // Use visible text only: tool receipts and reasoning are not preview content.
      const text = getTextAndImageContent(message)
        .textContent.trim()
        .replace(/\s+/g, ' ')
        .slice(0, 220);
      if (
        message.role === 'user' &&
        message.id &&
        getToolResponses(message).length === 0 &&
        message.content.some((part) => part.type === 'text' || part.type === 'image')
      ) {
        result.push({ id: message.id, question: text, answer: '' });
      } else if (message.role === 'assistant' && text && result.length) {
        result[result.length - 1].answer = text;
      }
    }
    return result;
  }, [messages]);

  useEffect(() => {
    const viewport = scrollRef.current?.viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = viewport.getBoundingClientRect().top + viewport.clientTop;
        const bottom = top + viewport.clientHeight;
        const anchors = Array.from(viewport.querySelectorAll<HTMLElement>('[data-chat-turn-id]'));
        const visible: string[] = [];
        for (const anchor of anchors) {
          const bounds = anchor.getBoundingClientRect();
          if (
            bounds.height > 0 &&
            bounds.bottom > top &&
            bounds.top < bottom &&
            anchor.dataset.chatTurnId
          ) {
            visible.push(anchor.dataset.chatTurnId);
          }
        }
        setVisibility((previous) =>
          previous.visible.length === visible.length &&
          previous.visible.every((id, index) => id === visible[index])
            ? previous
            : { firstVisibleId: visible[0], visible }
        );
      });
    };
    viewport.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(viewport);
    // History expansion, streamed replies and disclosure changes can move turns
    // without a scroll event or a viewport resize.
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      viewport.removeEventListener('scroll', update);
    };
  }, [messages, scrollRef]);

  useEffect(() => {
    const rail = railRef.current;
    const tick = currentTickRef.current;
    // While browsing the timeline, leave its scroll position under user control.
    if (!rail || !tick || rail.matches(':hover, :focus-within')) return;
    const top = tick.offsetTop;
    const bottom = top + tick.offsetHeight;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
  }, [visibility.firstVisibleId, turns.length]);

  if (turns.length < 2) return null;
  return (
    <nav ref={railRef} className="conversation-timeline" aria-label={intl.formatMessage(labels.navigation)}>
      {turns.map((turn, index) => (
        <Tooltip key={turn.id} delayDuration={180}>
          <TooltipTrigger asChild>
            <button
              ref={visibility.firstVisibleId === turn.id ? currentTickRef : undefined}
              type="button"
              className="conversation-timeline-tick"
              aria-label={intl.formatMessage(labels.turn, {
                number: index + 1,
                text: turn.question || intl.formatMessage(labels.attachment),
              })}
              aria-current={visibility.firstVisibleId === turn.id ? 'location' : undefined}
              data-visible={visibility.visible.includes(turn.id) ? 'true' : undefined}
              onClick={() => onNavigate(turn.id)}
            >
              <span />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            sideOffset={10}
            collisionPadding={12}
            className="conversation-timeline-preview"
            arrowClassName="invisible"
          >
            <strong>{turn.question || intl.formatMessage(labels.attachment)}</strong>
            <p>{turn.answer || intl.formatMessage(labels.noReply)}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </nav>
  );
}
