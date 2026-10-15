import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getAnyToolConfirmationData, getToolResponses, type Message } from '../types/message';
import { getTurnTerminalRecord } from '../types/turnTerminal';
import { isProgressTool, presentedToolCall } from './codepro/CodeProToolContent';
import { ScrollFollowingContext } from './ui/scroll-follow-context';
import { resolveToolLoadingStatus } from './ToolCallWithResponse';

const TICK_MS = 40;
const MAX_CHARS_PER_TICK = 8; // 200 characters/second, including Chinese characters.
const TEXT_FADE_MS = 160;
const CARD_INTERVAL_MS = 100;
const THOUGHT_COLLAPSE_MS = 280;

// One display cursor for public text and cards. Execution and receipts stay in
// the source store; only this local projection is paced, never persisted.
export function useOrderedToolPresentation(messages: Message[], active: boolean) {
  const following = useContext(ScrollFollowingContext);
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(query?.matches ?? false);
    const visibility = () => setHidden(document.visibilityState === 'hidden');
    query?.addEventListener('change', changed);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      query?.removeEventListener('change', changed);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  const units = useMemo(
    () =>
      messages.flatMap((message, index) =>
        message.role === 'assistant' && message.metadata.userVisible
          ? message.content.flatMap((content, part) => {
              if (content.type === 'toolResponse') return [];
              const call = content.type === 'toolRequest' ? presentedToolCall(content) : undefined;
              const progress =
                call && isProgressTool(call.name) && typeof call.arguments.text === 'string';
              return [
                {
                  key:
                    content.type === 'toolRequest'
                      ? 'tool:' + content.id
                      : (message.id ?? index) + ':' + part + ':' + content.type,
                  index,
                  part,
                  kind: progress ? 'progress' : content.type,
                  text:
                    content.type === 'text'
                      ? content.text
                      : progress
                        ? (call.arguments.text as string)
                        : undefined,
                },
              ];
            })
          : []
      ),
    [messages]
  );
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    // Tool responses can also use role=user; they are not a new human turn.
    if (
      message.role === 'user' &&
      message.metadata.userVisible &&
      message.content.some((content) => content.type === 'text' || content.type === 'image')
    )
      lastUserIndex = index;
  });
  const user = messages[lastUserIndex]?.id;
  const cursor = useRef({
    user,
    active,
    hasLiveArrival: active,
    shown: new Map(units.map((unit) => [unit.key, unit.text?.length ?? 1])),
    nextAt: 0,
    lastTick: 0,
    thoughtBoundaries: new Set<string>(),
  });
  const [, repaint] = useState(0);
  const urgentKeys = useMemo(
    () =>
      messages.slice(Math.max(0, lastUserIndex)).flatMap((message, index) => {
        const terminal = getTurnTerminalRecord(message);
        const urgent =
          !!getAnyToolConfirmationData(message) ||
          (terminal && terminal.status !== 'completed') ||
          getToolResponses(message).some(
            (response) => resolveToolLoadingStatus(response, false) === 'error'
          );
        return urgent ? [message.id ?? String(lastUserIndex + index)] : [];
      }),
    [messages, lastUserIndex]
  );
  const seenUrgent = useRef(new Set(urgentKeys));
  const urgent = urgentKeys.some((key) => !seenUrgent.current.has(key));
  const bypass = reduced || hidden || !following || urgent;
  useLayoutEffect(() => {
    const state = cursor.current;
    urgentKeys.forEach((key) => seenUrgent.current.add(key));
    const newTurn = state.user !== user;
    const hadPending = units.some(
      (unit) =>
        state.shown.has(unit.key) && (state.shown.get(unit.key) ?? 0) < (unit.text?.length ?? 1)
    );
    // React may batch the last events together with the idle notification.
    // Idle is not a request to flush an already live presentation.
    const history = !active && !state.active && !hadPending && !state.hasLiveArrival;
    let displayChanged = false;
    for (const unit of units) {
      if (bypass || history || unit.index < lastUserIndex) {
        const length = unit.text?.length ?? 1;
        if ((state.shown.get(unit.key) ?? 0) !== length) {
          state.shown.set(unit.key, length);
          displayChanged = true;
        }
      } else if (!state.shown.has(unit.key)) {
        state.shown.set(unit.key, 0);
      }
    }
    if (newTurn || bypass || history) state.nextAt = 0;
    if (!bypass && !history) {
      const next = units.findIndex(
        (unit) => (state.shown.get(unit.key) ?? 0) < (unit.text?.length ?? 1)
      );
      if (
        next > 0 &&
        units[next - 1].kind === 'thinking' &&
        !state.thoughtBoundaries.has(units[next].key)
      ) {
        state.thoughtBoundaries.add(units[next].key);
        state.nextAt = Math.max(state.nextAt, window.performance.now() + THOUGHT_COLLAPSE_MS);
      }
    }
    state.user = user;
    state.active = active;
    state.hasLiveArrival ||= active;
    // A new array or another thought fragment does not itself advance the
    // display cursor. Repainting on every commit can recursively schedule
    // synchronous updates; live progress is driven by the animation frame.
    if (displayChanged) repaint((value) => value + 1);
  }, [units, active, user, lastUserIndex, bypass, urgentKeys]);

  useEffect(() => {
    if (bypass) return;
    let frame = 0;
    const tick = (now: number) => {
      const state = cursor.current;
      let pending = false;
      if (now >= state.nextAt && now - state.lastTick >= TICK_MS) {
        for (const unit of units) {
          const length = unit.text?.length ?? 1;
          let shown = state.shown.get(unit.key) ?? 0;
          if (shown >= length) continue;
          pending = true;
          if (unit.text !== undefined) {
            const count = Math.min(
              MAX_CHARS_PER_TICK,
              Math.max(1, Math.ceil((length - shown) / 12))
            );
            for (let n = 0; n < count && shown < length; n += 1) {
              shown += unit.text.codePointAt(shown)! > 0xffff ? 2 : 1;
            }
            if (shown >= length) state.nextAt = now + TEXT_FADE_MS;
          } else {
            shown = 1;
            state.nextAt =
              now +
              (unit.kind === 'toolRequest'
                ? CARD_INTERVAL_MS
                : unit.kind === 'thinking'
                  ? THOUGHT_COLLAPSE_MS
                  : 0);
          }
          state.shown.set(unit.key, shown);
          state.lastTick = now;
          repaint((value) => value + 1);
          break;
        }
      } else {
        pending = units.some((unit) => (state.shown.get(unit.key) ?? 0) < (unit.text?.length ?? 1));
      }
      if (pending) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [units, bypass]);

  if (bypass) return { messages, pending: false };
  const blocked = units.find(
    (unit) => (cursor.current.shown.get(unit.key) ?? 0) < (unit.text?.length ?? 1)
  );
  if (!blocked) return { messages, pending: false };
  const visible = messages.slice(0, blocked.index);
  const message = messages[blocked.index];
  const content = message.content.slice(0, blocked.part);
  const shown = cursor.current.shown.get(blocked.key) ?? 0;
  const item = message.content[blocked.part];
  if (shown > 0 && blocked.text !== undefined) {
    const text = blocked.text.slice(0, shown);
    if (item.type === 'text') content.push({ ...item, text });
    else if (item.type === 'toolRequest' && item.toolCall.status === 'success') {
      const call = presentedToolCall(item);
      if (call)
        content.push({
          ...item,
          toolCall: {
            ...item.toolCall,
            value: { ...call, arguments: { ...call.arguments, text } },
          },
        });
    }
  }
  if (content.length > 0) visible.push({ ...message, content });
  return { messages: visible, pending: true };
}
