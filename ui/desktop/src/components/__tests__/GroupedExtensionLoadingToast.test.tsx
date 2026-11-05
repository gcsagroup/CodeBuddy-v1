import { ToastContainer } from 'react-toastify';
import { toastSuccess, toastLoading } from '../../toasts';
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GroupedExtensionLoadingToast } from '../GroupedExtensionLoadingToast';
import { IntlTestWrapper } from '../../i18n/test-utils';

const renderWithRouter = (component: React.ReactElement) => {
  return render(
    <IntlTestWrapper>
      <MemoryRouter>{component}</MemoryRouter>
    </IntlTestWrapper>
  );
};

describe('GroupedExtensionLoadingToast', () => {
  it('renders loading state correctly', () => {
    const extensions = [
      { name: 'developer', status: 'loading' as const },
      { name: 'memory', status: 'loading' as const },
    ];

    renderWithRouter(
      <GroupedExtensionLoadingToast extensions={extensions} totalCount={2} isComplete={false} />
    );

    expect(screen.getByText('Loading 2 extensions...')).toBeInTheDocument();
    expect(screen.getByText('Show details')).toBeInTheDocument();
  });

  it('renders success state correctly', () => {
    const extensions = [
      { name: 'developer', status: 'success' as const },
      { name: 'memory', status: 'success' as const },
    ];

    renderWithRouter(
      <GroupedExtensionLoadingToast extensions={extensions} totalCount={2} isComplete={true} />
    );

    expect(screen.getByText('Successfully loaded 2 extensions')).toBeInTheDocument();
    expect(screen.getByText('Show details')).toBeInTheDocument();
  });

  it('renders partial failure state correctly', () => {
    const extensions = [
      { name: 'developer', status: 'success' as const },
      { name: 'memory', status: 'error' as const, error: 'Failed to connect' },
    ];

    renderWithRouter(
      <GroupedExtensionLoadingToast extensions={extensions} totalCount={2} isComplete={true} />
    );

    expect(screen.getByText('Loaded 1/2 extensions')).toBeInTheDocument();
    expect(screen.getByText('1 extension failed to load')).toBeInTheDocument();
    expect(screen.getByText('Show details')).toBeInTheDocument();
  });

  it('renders single extension correctly', () => {
    const extensions = [{ name: 'developer', status: 'success' as const }];

    renderWithRouter(
      <GroupedExtensionLoadingToast extensions={extensions} totalCount={1} isComplete={true} />
    );

    expect(screen.getByText('Successfully loaded 1 extension')).toBeInTheDocument();
  });

  it('renders mixed status states correctly', () => {
    const extensions = [
      { name: 'developer', status: 'success' as const },
      { name: 'memory', status: 'loading' as const },
      { name: 'Square MCP Server', status: 'error' as const, error: 'Connection failed' },
    ];

    renderWithRouter(
      <GroupedExtensionLoadingToast extensions={extensions} totalCount={3} isComplete={false} />
    );

    // Summary should show loading state with error count
    expect(screen.getByText('Loading 3 extensions...')).toBeInTheDocument();
    expect(screen.getByText('1 extension failed to load')).toBeInTheDocument();
    expect(screen.getByText('Show details')).toBeInTheDocument();
  });
});

it('opens and closes extension details with the keyboard and keeps updates visible', async () => {
  const user = userEvent.setup();
  const view = (status: 'loading' | 'error') => (
    <IntlTestWrapper>
      <MemoryRouter>
        <GroupedExtensionLoadingToast
          extensions={[
            {
              name: 'browser-fixture',
              status,
              error: status === 'error' ? 'Connection timed out' : undefined,
            },
          ]}
          totalCount={1}
          isComplete={status === 'error'}
        />
      </MemoryRouter>
    </IntlTestWrapper>
  );
  const { rerender } = render(view('loading'));
  expect(screen.queryByText('Browser Fixture')).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Expand details' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByText('Browser Fixture')).toBeVisible();
  rerender(view('error'));
  expect(screen.getByText('Connection timed out')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy error' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Collapse details' }));
  expect(screen.queryByText('Connection timed out')).not.toBeInTheDocument();
});

it.each([toastSuccess, toastLoading])(
  'shows a notification body without requiring a title',
  async (notify) => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <button onClick={() => notify({ msg: 'Body without a heading' })}>Notify</button>
        <ToastContainer />
      </>
    );
    await user.click(screen.getByRole('button', { name: 'Notify' }));
    expect(await screen.findByText('Body without a heading')).toBeVisible();
  }
);
