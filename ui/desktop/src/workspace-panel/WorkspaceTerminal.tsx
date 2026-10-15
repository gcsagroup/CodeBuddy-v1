import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, Eraser } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PanelScope } from './workspacePanelTypes';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';

export function WorkspaceTerminal({ scope, id }: { scope: PanelScope; id: string }) {
  const intl = useIntl();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [exited, setExited] = useState(false);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.45,
      minimumContrastRatio: 4.5,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      fontFamily: 'Cascadia Code, Consolas, monospace',
      scrollback: 5000,
      theme: { background: '#15171c', foreground: '#e6e8ee' },
    });
    terminal.current = term;
    const theme = () => {
      if (!host.current) return;
      const styles = window.getComputedStyle(host.current);
      term.options.theme = {
        background: styles.getPropertyValue('--color-background-primary').trim() || '#ffffff',
        foreground: styles.getPropertyValue('--color-text-primary').trim() || '#263244',
        cursor: '#5b8def',
        selectionBackground: '#5b8def40',
      };
    };
    theme();
    const themeObserver = new MutationObserver(theme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    let alive = true,
      offset = 0;
    const fail = (e: unknown) => {
      if (alive) setError(String(e));
    };
    const resize = () => {
      if (!alive || !host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      void window.electron
        .workspacePanel({ scope, action: 'terminal-resize', id, cols: term.cols, rows: term.rows })
        .catch(fail);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = term.onData((data) => {
      void window.electron
        .workspacePanel({ scope, action: 'terminal-input', id, data })
        .catch(fail);
    });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await window.electron.workspacePanel({
          scope,
          action: 'terminal-read',
          id,
          offset,
        });
        if (!alive) return;
        if (result.reset) term.write('\r\n[Earlier output trimmed]\r\n');
        if (result.data) term.write(result.data);
        offset = result.offset ?? offset;
        setExited(!!result.exited);
        if (!result.exited) timer = setTimeout(() => void poll(), 120);
      } catch (e) {
        fail(e);
      }
    };
    resize();
    term.focus();
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      observer.disconnect();
      themeObserver.disconnect();
      terminal.current = null;
      input.dispose();
      term.dispose();
    };
  }, [scope, id]);
  return (
    <div className="wb-terminal flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="wb-toolbar">
        <TerminalSquare size={15} />
        <span className="min-w-0 flex-1 truncate" title={scope.root}>
          {scope.root}
        </span>
        <button
          className="wb-icon"
          title={intl.formatMessage(m.clearTerminal)}
          aria-label={intl.formatMessage(m.clearTerminal)}
          onClick={() => {
            terminal.current?.clear();
            terminal.current?.focus();
          }}
        >
          <Eraser size={15} />
        </button>
      </div>
      {error && (
        <p role="alert" className="p-2 text-red-500 text-xs">
          {error}
        </p>
      )}
      <div
        ref={host}
        className="wb-terminal-surface min-h-0 flex-1"
        aria-label={intl.formatMessage(m.terminalHint)}
      />
      <footer className="wb-statusbar">
        <span>
          <span className={`wb-status-dot ${exited ? 'is-exited' : ''}`} />
          {intl.formatMessage(exited ? m.exited : m.running)}
        </span>
        <span>{intl.formatMessage(m.terminalKeys)}</span>
      </footer>
    </div>
  );
}
