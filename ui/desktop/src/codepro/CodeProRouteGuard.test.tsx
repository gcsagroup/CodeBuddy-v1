import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CodeProRouteGuard } from './CodeProRouteGuard';

function LocationProbe() {
  const location = useLocation();
  return (
    <div>
      {location.pathname}
      {location.search}|{String((location.state as { source?: string } | null)?.source)}
    </div>
  );
}

function renderGuard(path: string, unifiedMode: boolean) {
  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: path, search: '?resumeSessionId=session-1', state: { source: 'legacy' } },
      ]}
    >
      <CodeProRouteGuard unifiedMode={unifiedMode}>
        <LocationProbe />
      </CodeProRouteGuard>
    </MemoryRouter>
  );
}

describe('CodeProRouteGuard', () => {
  it('replaces a legacy route while preserving search parameters and state', async () => {
    renderGuard('/pair', true);

    expect(
      await screen.findByText('/codepro/pair?resumeSessionId=session-1|legacy')
    ).toBeInTheDocument();
  });

  it('does not redirect a canonical CodePro route', () => {
    renderGuard('/codepro/settings', true);

    expect(
      screen.getByText('/codepro/settings?resumeSessionId=session-1|legacy')
    ).toBeInTheDocument();
  });

  it('keeps the legacy route when rollback is explicit', () => {
    renderGuard('/pair', false);

    expect(screen.getByText('/pair?resumeSessionId=session-1|legacy')).toBeInTheDocument();
  });
});
