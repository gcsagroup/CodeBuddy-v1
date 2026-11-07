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

function renderGuard(path: string) {
  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: path, search: '?resumeSessionId=session-1', state: { source: 'legacy' } },
      ]}
    >
      <CodeProRouteGuard>
        <LocationProbe />
      </CodeProRouteGuard>
    </MemoryRouter>
  );
}

describe('CodeProRouteGuard', () => {
  it('replaces a legacy route while preserving search parameters and state', async () => {
    renderGuard('/pair');

    expect(
      await screen.findByText('/codepro/pair?resumeSessionId=session-1|legacy')
    ).toBeInTheDocument();
  });

  it('does not redirect a canonical CodePro route', () => {
    renderGuard('/codepro/settings');

    expect(
      screen.getByText('/codepro/settings?resumeSessionId=session-1|legacy')
    ).toBeInTheDocument();
  });

  it('redirects the old home to the unified home', async () => {
    renderGuard('/');
    expect(await screen.findByText('/codepro?resumeSessionId=session-1|legacy')).toBeInTheDocument();
  });
});
