import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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
it('keeps a loaded native page visible beside popovers and restores it after a covering layer closes', async () => {
  invoke.mockImplementation(async (r: PanelRequest) =>
    r.action === 'browser-state' ? { browser: { url: 'https://example.com', title: 'Loaded' } } : {}
  );
  const page = new DOMRect(600, 100, 400, 500);
  const view = render(<WorkspaceBrowser scope={scope} id="loaded" />, { wrapper: IntlTestWrapper });
  const host = view.container.querySelector('.wb-statusbar')!.previousElementSibling!;
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(page);
  const bounds = () => {
    const calls = invoke.mock.calls.filter(([request]) => request.action === 'browser-bounds');
    return calls[calls.length - 1]?.[0].bounds;
  };
  const expected = { x: 600, y: 100, width: 400, height: 500 };
  await waitFor(() => expect(bounds()).toEqual(expected));
  const popup = document.createElement('div');
  let box = new DOMRect(20, 400, 200, 90);
  vi.spyOn(popup, 'getBoundingClientRect').mockImplementation(() => box);
  popup.setAttribute('role', 'dialog');
  try {
    await act(async () => { document.body.append(popup); });
    expect(bounds()).toEqual(expected);
    box = new DOMRect(590, 400, 50, 90);
    popup.setAttribute('data-state', 'open');
    await waitFor(() => expect(bounds()).toBeNull());
    popup.style.visibility = 'hidden';
    await waitFor(() => expect(bounds()).toEqual(expected));
    popup.removeAttribute('role');
    popup.setAttribute('data-slot', 'dialog-overlay');
    popup.style.visibility = 'visible';
    await waitFor(() => expect(bounds()).toBeNull());
    popup.remove();
    await waitFor(() => expect(bounds()).toEqual(expected));
  } finally { popup.remove(); view.unmount(); }
});
