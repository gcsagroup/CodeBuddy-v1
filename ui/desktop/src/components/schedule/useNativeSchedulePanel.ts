import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useNativeSchedules } from '../../acp/nativeSchedules';
import { OPEN_NATIVE_SCHEDULE } from './scheduleEvents';

// The route owns panel selection. Catalog refreshes may update a task, but must
// neither carry another chat's panel over nor reopen a manually closed panel.
export function useNativeSchedulePanel() {
  const location = useLocation();
  const catalog = useNativeSchedules();
  const isChat = location.pathname === '/pair' || location.pathname === '/codepro/pair';
  const sessionId = isChat ? new URLSearchParams(location.search).get('resumeSessionId') : null;
  const scope = isChat ? `chat:${sessionId ?? ''}` : location.pathname;
  const [selection, setSelection] = useState<{ scope: string; id: string | null | undefined }>({
    scope,
    id: undefined,
  });
  if (selection.scope !== scope) setSelection({ scope, id: undefined });
  const selected = selection.scope === scope ? selection.id : undefined;
  const linked = catalog.records.filter((record) => sessionId && record.sessionId === sessionId);
  const id =
    selected === undefined
      ? (linked[0]?.id ?? null)
      : isChat && selected && !linked.some((record) => record.id === selected)
        ? null
        : selected;

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (typeof id === 'string' && id) setSelection({ scope, id });
    };
    window.addEventListener(OPEN_NATIVE_SCHEDULE, open);
    return () => window.removeEventListener(OPEN_NATIVE_SCHEDULE, open);
  }, [scope]);
  return { id, close: () => setSelection({ scope, id: null }) };
}
