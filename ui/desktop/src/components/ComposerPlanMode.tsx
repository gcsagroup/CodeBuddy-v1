import { useEffect, useState } from 'react';
import { ListChecks, X } from 'lucide-react';
import { getSessionPlanMode } from '../acp/goals';
import { useIntl } from '../i18n';
import { composerMessages } from './composerCommands';

export function ComposerPlanMode({
  sessionId,
  busy,
  refreshKey,
  onExit,
}: {
  sessionId: string | null;
  busy: boolean;
  refreshKey: number;
  onExit: () => void;
}) {
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<{ sessionId: string; active: boolean }>();
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false,
      inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const plan = await getSessionPlanMode(sessionId);
        if (!disposed) setSnapshot({ sessionId, active: plan.active });
      } catch {
        /* Keep the last confirmed state during reconnection. */
      } finally {
        inFlight = false;
      }
    };
    void read();
    const timer = busy ? setInterval(() => void read(), 2000) : undefined;
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sessionId, busy, refreshKey]);
  if (snapshot?.sessionId !== sessionId || !snapshot?.active) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2 py-1 text-xs text-blue-500 hover:bg-blue-500/20"
      title={intl.formatMessage(composerMessages.planOff)}
      aria-label={intl.formatMessage(composerMessages.planOff)}
      onClick={onExit}
    >
      <ListChecks size={13} />
      {intl.formatMessage(composerMessages.plan)}
      <X size={12} />
    </button>
  );
}
