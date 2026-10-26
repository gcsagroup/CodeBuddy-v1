import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import RepositoryConnections from './RepositoryConnections';
vi.mock('./GitHubConnections', () => ({ default: () => <div>GitHub: connected</div> }));
it('shares one account flow without local Git switches or advanced configuration', () => {
  render(<RepositoryConnections />, { wrapper: IntlTestWrapper });
  expect(screen.getByText('GitHub: connected')).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('Local Git')).toBeNull();
});
