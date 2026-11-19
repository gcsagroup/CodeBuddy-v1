import { useEffect, useRef, useState } from 'react';
import { useIntl } from '../i18n';
import { completionIdleMs } from '../utils/completionReminder';
import { CodeBuddyMark } from './CodeBuddyMark';

export function CompletionReminderCard({ title, body, draft = '', initialError = '', open, send, onExpire }: {
  title: string;
  body: string;
  draft?: string;
  initialError?: string;
  open: () => void;
  send: (text: string) => Promise<void>;
  onExpire?: () => void;
}) {
  const intl = useIntl();
  const [text, setText] = useState(draft);
  const [error, setError] = useState(initialError);
  const [sending, setSending] = useState(false);
  const locked = useRef(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!onExpire || hover || focus || text || sending || error) return;
    const timer = setTimeout(onExpire, completionIdleMs);
    return () => clearTimeout(timer);
  }, [onExpire, hover, focus, text, sending, error]);
  const placeholder = intl.formatMessage({ id: 'app.completionFollowUp', defaultMessage: 'Add a follow-up…' });
  return (
    <div className="completion-card" onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)} onFocus={() => setFocus(true)}
      onBlur={event => setFocus(event.currentTarget.contains(event.relatedTarget))}>
      <div className="completion-card-meta"><CodeBuddyMark className="completion-card-mark" />
        <strong>CodeBuddy</strong>
        <span className="completion-card-status">{intl.formatMessage({
          id: 'codeProStepSummary.taskCompleted', defaultMessage: 'Task completed',
        })}</span>
      </div>
      <button type="button" className="completion-card-result" onClick={open}>
        <strong className="completion-card-title">{title}</strong>
        <span className="completion-card-preview">{body}</span>
      </button>
      <form className="completion-card-reply" onSubmit={async event => {
        event.preventDefault();
        const value = text.trim();
        if (!value || locked.current) return;
        locked.current = true;
        setSending(true);
        setError('');
        try {
          await send(value);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          locked.current = false;
          setSending(false);
        }
      }}>
        <input aria-label={placeholder} placeholder={placeholder} value={text} disabled={sending}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229))
              event.preventDefault();
          }}
          onChange={event => setText(event.target.value)} />
        <button type="submit" disabled={sending || !text.trim()}>
          {intl.formatMessage({ id: 'chatInput.send', defaultMessage: 'Send' })}
        </button>
      </form>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
