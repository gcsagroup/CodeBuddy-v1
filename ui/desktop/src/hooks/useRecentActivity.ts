import { useEffect, useState } from 'react';

// A live badge describes recently received data, not what the model is doing internally.
export function useRecentActivity(receivedAt?: number): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (receivedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, receivedAt + 3000 - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [receivedAt]);
  return receivedAt !== undefined && Math.max(now, Date.now()) - receivedAt < 3000;
}
