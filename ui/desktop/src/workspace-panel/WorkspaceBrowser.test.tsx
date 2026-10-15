import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceBrowser } from './WorkspaceBrowser';
import type { PanelRequest } from './workspacePanelTypes';

const invoke = vi.fn();
const scope = { sessionId: 'browser-style', root: 'D:\\fixture' };
beforeEach(() => {
  invoke.mockReset();
  Object.assign(window.electron, { workspacePanel: invoke });
  invoke.mockImplementation(async (r: PanelRequest) =>
    r.action === 'browser-state'
      ? { browser: { url: 'about:blank', title: '', loading: false, back: false, forward: false } }
      : {}
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

it('shows the empty page without a native blank view covering it, then submits the entered URL', async () => {
  const view = render(<WorkspaceBrowser scope={scope} id="web-style" />, {
    wrapper: IntlTestWrapper,
  });
  expect(await screen.findByText('Enter an address above to browse a web page.')).toBeVisible();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({
      scope,
      id: 'web-style',
      action: 'browser-bounds',
      bounds: null,
    })
  );
  expect(screen.getByTitle('Back')).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Web address' }), {
    target: { value: 'https://example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open address' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({
      scope,
      id: 'web-style',
      action: 'browser-navigate',
      url: 'https://example.com',
    })
  );
  view.unmount();
});

it('uses stop while loading and displays navigation failures', async () => {
  invoke.mockImplementation(async (r: PanelRequest) => {
    if (r.action === 'browser-state')
      return {
        browser: {
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          back: true,
          forward: false,
        },
      };
    if (r.action === 'browser-command') throw Error('Page is unavailable');
    return {};
  });
  const view = render(<WorkspaceBrowser scope={scope} id="web-style" />, {
    wrapper: IntlTestWrapper,
  });
  fireEvent.click(await screen.findByTitle('Stop loading'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Page is unavailable');
  expect(invoke).toHaveBeenCalledWith({
    scope,
    id: 'web-style',
    action: 'browser-command',
    command: 'stop',
  });
  view.unmount();
});
