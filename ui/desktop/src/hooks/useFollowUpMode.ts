import { useEffect, useState } from 'react';
import type { Settings } from '../utils/settings';

export type FollowUpMode = Settings['followUpMode'];
const readMode = (value: unknown): FollowUpMode => {
  if (value === undefined || value === 'steer') return 'steer';
  if (value === 'queue') return 'queue';
  throw new Error('Invalid follow-up mode');
};

export function useFollowUpMode() {
  const [mode, setMode] = useState<FollowUpMode>('steer');
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let acceptInitial = true;
    setReady(false); setError(false);
    const accept = (value: unknown) => {
      try { setMode(readMode(value)); setReady(true); setError(false); }
      catch { setReady(false); setError(true); }
    };
    const unsubscribe = window.electron.on('follow-up-mode-changed', (_event, value) => {
      acceptInitial = false;
      accept(value);
    });
    void Promise.resolve(window.electron.getSetting('followUpMode')).then(value => {
      if (acceptInitial) accept(value);
    }).catch(() => { if (acceptInitial) setError(true); });
    return () => { acceptInitial = false; unsubscribe?.(); };
  }, [revision]);
  return { mode, ready, error, reload: () => setRevision(value => value + 1) };
}
