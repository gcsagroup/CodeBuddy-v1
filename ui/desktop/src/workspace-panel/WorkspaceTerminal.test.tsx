import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceTerminal } from './WorkspaceTerminal';
import type { PanelRequest } from './workspacePanelTypes';

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  input: undefined as undefined | ((data: string) => void),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    clear = mocks.clear;
    focus = mocks.focus;
    dispose = mocks.dispose;
    write = mocks.write;
    onData(cb: (data: string) => void) {
      mocks.input = cb;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
const invoke = vi.fn();
const scope = { sessionId: 'terminal-style', root: 'D:\\fixture' };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window.electron, { workspacePanel: invoke });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  invoke.mockImplementation(async (r: PanelRequest) =>
    r.action === 'terminal-read' ? { data: 'fixture output', offset: 14, exited: true } : {}
  );
});
it('displays process exit and clears only the display without sending a shell command', async () => {
  const view = render(<WorkspaceTerminal scope={scope} id="pty-style" />, {
    wrapper: IntlTestWrapper,
  });
  expect(await screen.findByText('Exited')).toBeVisible();
  expect(mocks.write).toHaveBeenCalledWith('fixture output');
  fireEvent.click(screen.getByRole('button', { name: 'Clear terminal display' }));
  expect(mocks.clear).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.some(([r]) => r.action === 'terminal-input')).toBe(false);
  view.unmount();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});
it('preserves the scoped input path', async () => {
  const view = render(<WorkspaceTerminal scope={scope} id="pty-style" />, {
    wrapper: IntlTestWrapper,
  });
  mocks.input?.('echo hello\r');
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({
      scope,
      id: 'pty-style',
      action: 'terminal-input',
      data: 'echo hello\r',
    })
  );
  view.unmount();
});
