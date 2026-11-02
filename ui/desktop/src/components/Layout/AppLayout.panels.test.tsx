import { useEffect, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { openNativeSchedule } from '../schedule/scheduleEvents';
import { OPEN_WORKSPACE_FILE } from '../../workspace-panel/workspaceFilePanel';

const state = vi.hoisted(() => ({
  workspaceMounts: 0,
  opens: 0,
  saves: 0,
  setChat: vi.fn(),
  setNav: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/codepro/pair', search: '?resumeSessionId=a' }),
  useNavigate: () => vi.fn(),
  Outlet: () => (
    <button
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent('codebuddy:open-workspace-file', {
            detail: { sessionId: 'a', filePath: 'cat-book.png' },
          })
        )
      }
    >
      Open generated image
    </button>
  ),
}));
vi.mock('../../acp/nativeSchedules', () => ({
  useNativeSchedules: () => ({ records: [{ id: 'task-a', sessionId: 'a' }] }),
}));
vi.mock('../../contexts/ChatContext', () => ({
  useChatContext: () => ({ setChat: state.setChat }),
}));
vi.mock('./NavigationContext', () => ({
  NavigationProvider: ({ children }: { children: ReactNode }) => children,
  useNavigationContext: () => ({ isNavExpanded: true, setIsNavExpanded: state.setNav }),
}));
vi.mock('./NavigationPanel', () => ({ Navigation: () => null }));
vi.mock('./NavigationSidebar', () => ({
  NavigationSidebar: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../ChatSessionsContainer', () => ({ default: () => null }));
vi.mock('../schedule/NativeScheduleDetails', () => ({
  NativeScheduleDetails: () => <div>Task rules</div>,
}));
vi.mock('../../workspace-panel/WorkspacePanel', () => ({
  WORKSPACE_PANEL_GAP: 0,
  WORKSPACE_PANEL_TRANSITION: { duration: 0 },
  WorkspaceSubagentProvider: ({ children }: { children: ReactNode }) => children,
  WorkspacePanel: ({ onExpandedChange }: { onExpandedChange: (expanded: boolean) => void }) => {
    const [file, setFile] = useState('Existing workspace tab');
    useEffect(() => {
      state.workspaceMounts += 1;
      const save = (event: KeyboardEvent) => {
        if (event.ctrlKey && event.key === 's') state.saves += 1;
      };
      window.addEventListener('keydown', save);
      return () => window.removeEventListener('keydown', save);
    }, []);
    useEffect(() => {
      const open = (event: Event) => {
        const target = (event as CustomEvent<{ sessionId: string; filePath: string }>).detail;
        if (target.sessionId !== 'a') return;
        state.opens += 1;
        onExpandedChange(true);
        setFile(target.filePath);
      };
      window.addEventListener(OPEN_WORKSPACE_FILE, open);
      return () => window.removeEventListener(OPEN_WORKSPACE_FILE, open);
    }, [onExpandedChange]);
    return <div>{file}</div>;
  },
}));

beforeEach(() => {
  state.workspaceMounts = 0;
  state.opens = 0;
  state.saves = 0;
  window.localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1200,
    height: 800,
    top: 0,
    right: 1200,
    bottom: 800,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('hands the first file click to the ordinary workspace without retaining hidden save effects', async () => {
  render(<AppLayout activeSessions={[]} />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(screen.getByText('Task rules')).toBeVisible());
  expect(screen.queryByText('Existing workspace tab')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  expect(state.saves).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Open generated image' }));
  expect(screen.queryByText('Task rules')).not.toBeInTheDocument();
  expect(screen.getByText('cat-book.png')).toBeVisible();
  expect(state.workspaceMounts).toBe(1);
  expect(state.opens).toBe(1);
  act(() => openNativeSchedule('task-a'));
  await waitFor(() => expect(screen.getByText('Task rules')).toBeVisible());
  expect(screen.queryByText('cat-book.png')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  expect(state.saves).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Open generated image' }));
  expect(screen.getByText('cat-book.png')).toBeVisible();
  expect(state.workspaceMounts).toBe(2);
  expect(state.opens).toBe(2);
});
