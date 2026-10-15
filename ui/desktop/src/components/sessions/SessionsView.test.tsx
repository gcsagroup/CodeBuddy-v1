import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SessionsView from './SessionsView';

vi.mock('../../hooks/useNavigation', () => ({
  useNavigation: () => vi.fn(),
}));

vi.mock('./SessionListView', () => ({
  default: ({ workspaceMode }: { workspaceMode?: string }) => (
    <div data-testid="session-workspace">{workspaceMode ?? 'missing'}</div>
  ),
}));

describe('SessionsView', () => {
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
