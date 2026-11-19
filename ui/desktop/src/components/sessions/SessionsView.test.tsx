import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SessionsView from './SessionsView';

const mocks = vi.hoisted(() => ({ load: vi.fn().mockResolvedValue(undefined), navigate: vi.fn() }));
vi.mock('../../acp/chatSessionController', () => ({
  acpChatSessionController: { loadSession: mocks.load },
}));

vi.mock('../../hooks/useNavigation', () => ({
  useNavigation: () => mocks.navigate,
}));

vi.mock('./SessionListView', () => ({
  default: ({
    workspaceMode,
    onSelectSession,
  }: {
    workspaceMode?: string;
    onSelectSession: (id: string) => void;
  }) => (
    <button data-testid="session-workspace" onClick={() => onSelectSession('old-chat')}>
      {workspaceMode ?? 'missing'}
    </button>
  ),
}));

describe('SessionsView', () => {
  it('starts history restore before switching to the conversation', () => {
    render(<SessionsView />);
    fireEvent.click(screen.getByTestId('session-workspace'));
    expect(mocks.load).toHaveBeenCalledWith('old-chat');
    expect(mocks.navigate).toHaveBeenCalledWith('pair', {
      disableAnimation: true,
      resumeSessionId: 'old-chat',
    });
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0]
    );
  });
  it.each([
    ['/sessions', 'unified'],
    ['/codepro/sessions', 'unified'],
  ])('shows the history for %s in the matching workspace', (route, expectedMode) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="*" element={<SessionsView />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('session-workspace')).toHaveTextContent(expectedMode);
  });
});
