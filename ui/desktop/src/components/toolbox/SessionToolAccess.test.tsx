/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { retryToolboxSession, type ToolboxSessionState } from '../../acp/toolboxSession';
import { SessionToolAccess } from './SessionToolAccess';

vi.mock('../../acp/toolboxSession', () => ({ retryToolboxSession: vi.fn() }));
vi.mock('../../acp/session-extensions', () => ({ addSessionExtension: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('replaces old readiness with pending, failure and removal from the same authoritative state', () => {
  const extension = { type: 'streamable_http' as const, name: 'remote', uri: 'http://localhost/mcp' };
  const state: ToolboxSessionState = { mode: 'follow', pending: false, running: false, selected: ['remote'], statuses: [{ serverName: 'remote', status: 'ready' }] };
  const view = (value: ToolboxSessionState) => <IntlTestWrapper><SessionToolAccess sessionId="chat" extension={extension} state={value} refresh={vi.fn()} /></IntlTestWrapper>;
  const { rerender } = render(view(state));
  expect(screen.getByRole('status')).toHaveTextContent('Connected');
  rerender(view({ ...state, pending: true, running: true }));
  expect(screen.getByRole('status')).toHaveTextContent('changes apply before the next turn');
  expect(screen.getByRole('button')).toBeDisabled();
  rerender(view({ ...state, statuses: [{ serverName: 'remote', status: 'error' }] }));
  expect(screen.getByRole('status')).toHaveTextContent('Connection failed');
  rerender(view({ ...state, selected: [], statuses: [] }));
  expect(screen.getByRole('status')).toHaveTextContent('Not loaded');
  expect(retryToolboxSession).not.toHaveBeenCalled();
});
