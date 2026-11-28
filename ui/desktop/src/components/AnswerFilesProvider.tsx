import { useMemo, type ReactNode } from 'react';
import { AnswerFiles, type AnswerFile } from './remarkDeliveredFileLinks';

export function AnswerFilesProvider({ sessionId, turnId, files = [], children }: {
  sessionId: string;
  turnId: string;
  files?: readonly AnswerFile[];
  children: ReactNode;
}) {
  // The link plugin reads only this ordered vocabulary. Receipt ledger objects
  // are reprojected during streaming; their identity must not invalidate every
  // completed Markdown block. Scope and real vocabulary edits still invalidate.
  const snapshot = JSON.stringify([sessionId, turnId, files.map(({ key, path }) => [key, path])]);
  const value = useMemo(() => {
    const [, , entries] = JSON.parse(snapshot) as [string, string, Array<[string, string]>];
    return entries.map(([key, path]) => ({ key, path }));
  }, [snapshot]);
  return <AnswerFiles.Provider value={value}>{children}</AnswerFiles.Provider>;
}
