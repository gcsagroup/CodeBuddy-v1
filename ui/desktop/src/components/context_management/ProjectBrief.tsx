import { useEffect, useState } from 'react';
import { getAcpControlClient } from '../../acp/acpConnection';
import { isRecord } from '../../acp/adapter/shared';
import { defineMessages, useIntl } from '../../i18n';
import MarkdownContent from '../MarkdownContent';
import { MainConversationAuthor } from '../MainConversationAuthor';

const m = defineMessages({
  heading: { id: 'projectBrief.heading', defaultMessage: 'Project brief' },
  files: { id: 'projectBrief.files', defaultMessage: 'Changed files ({count})' },
  noReply: { id: 'projectBrief.noReply', defaultMessage: 'This turn has no final text reply.' },
  loading: { id: 'projectBrief.loading', defaultMessage: 'Reading this turn…' },
  unavailable: { id: 'projectBrief.unavailable', defaultMessage: 'Could not read this project turn.' },
  retry: { id: 'projectBrief.retry', defaultMessage: 'Try again' },
});

type Brief = { title: string; task: string; result: string; files: string[]; fileCount: number };

function isBrief(data: unknown): data is Brief {
  return isRecord(data) && typeof data.title === 'string' && typeof data.task === 'string' &&
    typeof data.result === 'string' && Number.isSafeInteger(data.fileCount) && Array.isArray(data.files) &&
    data.files.every(file => typeof file === 'string');
}

export function ProjectBrief({ mainId, childId, requestId, title, snapshot }: {
  mainId: string; childId: string; requestId: string; title?: string; snapshot?: unknown;
}) {
  const intl = useIntl();
  const [legacyBrief, setLegacyBrief] = useState<Brief>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const brief = isBrief(snapshot) ? snapshot : legacyBrief;
  useEffect(() => {
    if (brief) return;
    let active = true;
    async function load() {
      const client = await getAcpControlClient();
      const data = await client.extMethod('_codebuddy/main-conversation/overview', {
        sessionId: mainId, detailSessionId: childId, requestId,
      });
      if (!isBrief(data)) throw Error('Invalid project brief');
      if (active) setLegacyBrief(data);
    }
    void load().catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [mainId, childId, requestId, brief, attempt]);
  const label = [intl.formatMessage(m.heading), title || brief?.title].filter(Boolean).join(' · ');
  return <article aria-label={label} className="my-5 min-w-0 text-sm">
    <MainConversationAuthor />
    <div className="pl-9">
    <h3 className="mb-2 font-semibold">{label}</h3>
    {brief ? <>
      {brief.result ? <MarkdownContent content={brief.result} sessionId={childId} /> : intl.formatMessage(m.noReply)}
      {brief.files.length > 0 && <p className="mt-2 break-words text-xs text-text-secondary">{intl.formatMessage(m.files, { count: brief.fileCount })} · {brief.files.join(' · ')}{brief.fileCount > brief.files.length && ' …'}</p>}
    </> : <div role="status" className="mt-2 text-xs text-text-secondary">
      {failed ? <>{intl.formatMessage(m.unavailable)} <button type="button" className="underline" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>{intl.formatMessage(m.retry)}</button></>
        : intl.formatMessage(m.loading)}
    </div>}
    </div>
  </article>;
}
