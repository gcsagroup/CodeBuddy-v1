import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ArrowUpRight, Globe, Scan, X } from 'lucide-react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import { formatToolAction } from '../components/toolActionPresentation';
import { controlFeedbackStyles } from '../controlFeedbackStyles';
import type { PanelBrowserState, PanelScope } from './workspacePanelTypes';

function isBrowserCovered(viewport: DOMRect) {
  // WebContentsView sits above the renderer. A Radix popover can have the
  // dialog role even when it is entirely inside the chat column.
  const layers = document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="dialog-overlay"], [data-slot="sheet-overlay"]'
  );
  for (const layer of layers) {
    const box = layer.getBoundingClientRect();
    if (!box.width || !box.height || window.getComputedStyle(layer).visibility !== 'visible') continue;
    if (layer.getAttribute('aria-modal') === 'true') return true;
    if (box.left < viewport.right && box.right > viewport.left &&
        box.top < viewport.bottom && box.bottom > viewport.top) return true;
  }
  return false;
}

export function WorkspaceBrowser({ scope, id }: { scope: PanelScope; id: string }) {
  const intl = useIntl();
  const [state, setState] = useState<PanelBrowserState>();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const host = useRef<HTMLDivElement>(null),
    focused = useRef(false);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>,
      previous = '',
      pageVisible = false;
    const fail = (e: unknown) => {
      if (alive) setError(String(e));
    };
    const position = () => {
      if (!alive) return;
      const rect = host.current?.getBoundingClientRect();
      const bounds =
        pageVisible && !document.hidden && rect && rect.width > 0 && rect.height > 0 && !isBrowserCovered(rect)
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      const next = JSON.stringify(bounds);
      if (next !== previous) {
        previous = next;
        void window.electron
          .workspacePanel({ scope, action: 'browser-bounds', id, bounds })
          .catch(fail);
      }
    };
    const poll = async () => {
      try {
        const r = await window.electron.workspacePanel({ scope, action: 'browser-state', id });
        if (!alive) return;
        setState(r.browser);
        pageVisible = !!r.browser?.url && r.browser.url !== 'about:blank';
        if (!focused.current && r.browser?.url)
          setAddress(r.browser.url === 'about:blank' ? '' : r.browser.url);
        position();
        timer = setTimeout(() => void poll(), 350);
      } catch (e) {
        fail(e);
      }
    };
    const resize = new ResizeObserver(position);
    if (host.current) resize.observe(host.current);
    const mutation = new MutationObserver(position);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'aria-hidden'],
    });
    window.addEventListener('resize', position);
    document.addEventListener('visibilitychange', position);
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('visibilitychange', position);
      void window.electron
        .workspacePanel({ scope, action: 'browser-bounds', id, bounds: null })
        .catch(() => {});
    };
  }, [scope, id]);
  const command = (command: 'back' | 'forward' | 'reload' | 'stop') => {
    void window.electron
      .workspacePanel({ scope, action: 'browser-command', id, command })
      .catch((e) => setError(String(e)));
  };
  const feedback = state?.id === id ? state.feedback : undefined;
  const actionLabel = feedback && formatToolAction(intl, 'browser_control', { operation: feedback.operation },
    feedback.phase === 'failed' ? undefined : feedback.phase);
  return (
    <div className="wb-browser flex min-h-0 min-w-0 flex-1 flex-col">
      <form
        className="wb-toolbar wb-browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          focused.current = false;
          setError('');
          void window.electron
            .workspacePanel({ scope, action: 'browser-navigate', id, url: address })
            .catch((e) => setError(String(e)));
        }}
      >
        <button
          type="button"
          className="wb-icon"
          title={intl.formatMessage(m.back)}
          disabled={!state?.back}
          onClick={() => command('back')}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="wb-icon"
          title={intl.formatMessage(m.forward)}
          disabled={!state?.forward}
          onClick={() => command('forward')}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="wb-icon"
          title={intl.formatMessage(state?.loading ? m.stop : m.refresh)}
          onClick={() => command(state?.loading ? 'stop' : 'reload')}
        >
          {state?.loading ? <X size={16} /> : <RotateCw size={16} />}
        </button>
        <div className="wb-address">
          <Globe size={14} aria-hidden="true" />
          <input
            className="wb-address-input"
            spellCheck={false}
            aria-label={intl.formatMessage(m.address)}
            placeholder="https://example.com"
            value={address}
            onFocus={(e) => {
              e.target.select();
              focused.current = true;
            }}
            onBlur={() => {
              focused.current = false;
            }}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button
            className="wb-icon"
            title={intl.formatMessage(m.go)}
            aria-label={intl.formatMessage(m.go)}
          >
            <ArrowUpRight size={16} />
          </button>
        </div>
      </form>
      {state?.loading && (
        <div className="wb-loading" role="progressbar" aria-label={intl.formatMessage(m.loading)} />
      )}
      {(error || state?.error) && (
        <p className="p-2 text-xs text-red-500" role="alert">
          {error || state?.error}
        </p>
      )}
      <div className="control-feedback wb-control-surface">
        <style>{controlFeedbackStyles}</style>
        <div className="wb-browser-caption">
          {!feedback && <span className="truncate" title={state?.title}>{state?.title || intl.formatMessage(m.browser)}</span>}
          <span role="status" className={feedback ? 'banner' : undefined} data-phase={feedback?.phase}>
            {feedback ? <>
              <span aria-hidden="true" className="mark"><Scan size={15} /></span>
              <b className="brand">CodeBuddy</b>
              <span className="status">{intl.formatMessage(m.browserControl)}</span>
              <span className="hint">{feedback.phase === 'failed'
                ? intl.formatMessage(m.browserActionFailed, { action: actionLabel }) : actionLabel}</span>
            </> : state?.loading ? intl.formatMessage(m.loading) : ''}
          </span>
        </div>
        {feedback && <div aria-hidden="true" className="glow" />}
        <div className="wb-native-viewport" ref={host}>
          {(!state?.url || state.url === 'about:blank') && (
            <div className="wb-browser-empty">
              <Globe size={36} strokeWidth={1} />
              <h3>{intl.formatMessage(m.browser)}</h3>
              <p>{intl.formatMessage(m.enterAddress)}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
