import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import {
  acpReadModelDisplaySettings,
  acpListProviderDetails,
  acpRefreshProviderModels,
} from '../../../../acp/providers';
import type { ProviderDetails } from '../../../../types/providers';
import ModelsBottomBar from './ModelsBottomBar';

const mocks = vi.hoisted(() => ({ change: vi.fn(), navigate: vi.fn(), configModel: 'model-A' }));
vi.mock('../../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    currentModel: mocks.configModel,
    currentProvider: 'p',
    changeModel: mocks.change,
  }),
}));
vi.mock('../../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpRefreshProviderModels: vi.fn(),
  acpReadModelDisplaySettings: vi.fn(),
  acpSaveThinkingEffort: vi.fn(),
  readThinkingDraft: vi.fn(),
  stageThinkingEffort: vi.fn(),
}));
vi.mock('../../../../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../predefinedModelsUtils', () => ({ getModelDisplayName: (name: string) => name }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => mocks.navigate,
}));
function provider(name: string, models: string[], configured = true): ProviderDetails {
  return {
    name,
    is_configured: configured,
    provider_type: 'Custom',
    metadata: {
      name,
      display_name: name,
      known_models: models.map((model) => ({ name: model, context_limit: 32768 })),
      config_keys: [],
      setup_steps: [],
      description: '',
      default_model: models[0],
      model_doc_link: '',
      model_selection_hint: null,
    },
  };
}
function setup() {
  const changed = vi.fn();
  const view = render(
    <ModelsBottomBar
      sessionId="chat"
      sessionLoaded
      sessionModel="model-A"
      sessionProvider="p"
      dropdownRef={{ current: document.createElement('div') }}
      setView={vi.fn()}
      onModelChanged={changed}
    />,
    {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/codepro/pair']}>
          <IntlTestWrapper>{children}</IntlTestWrapper>
        </MemoryRouter>
      ),
    }
  );
  return { ...view, changed };
}
async function openModels(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole('button', { name: 'Thinking effort: On' });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'model-A' }));
  return trigger;
}
it('refreshes remote inventory once, shows new models and preserves selection', async () => {
  const user = userEvent.setup();
  setup();
  await openModels(user);
  let complete!: () => void;
  vi.mocked(acpRefreshProviderModels).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  const refresh = screen.getByRole('button', { name: 'Refresh models' });
  await user.click(refresh);
  expect(refresh).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing models');
  await user.click(refresh);
  expect(acpRefreshProviderModels).toHaveBeenCalledTimes(1);
  expect(acpRefreshProviderModels).toHaveBeenCalledWith('p');
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    provider('p', ['model-A', 'new-remote-model']),
  ]);
  await act(async () => complete());
  expect(await screen.findByRole('button', { name: 'new-remote-model' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'model-A' })).toHaveAttribute('aria-pressed', 'true');
  expect(mocks.change).not.toHaveBeenCalled();
  expect(refresh).toBeEnabled();
});

it('keeps a failed connection list while updating successful connections and allows retry', async () => {
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    provider('p', ['model-A']),
    provider('offline', ['old-model']),
  ]);
  const user = userEvent.setup();
  setup();
  await openModels(user);
  vi.mocked(acpRefreshProviderModels).mockImplementation(async (id) => {
    if (id === 'offline') throw new Error('PRIVATE_ENDPOINT');
  });
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    provider('p', ['model-A', 'new-model']),
    provider('offline', ['old-model']),
  ]);
  await user.click(screen.getByRole('button', { name: 'Refresh models' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('1 of 2 connections');
  expect(screen.getByRole('alert')).toHaveTextContent('offline · No specific reason was reported. Showing the last saved list.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE_ENDPOINT');
  expect(screen.getByRole('button', { name: 'new-model' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'offline (1)' }));
  expect(screen.getByRole('button', { name: 'old-model' })).toBeVisible();
  vi.mocked(acpRefreshProviderModels).mockResolvedValue();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByRole('status')).toHaveTextContent('Model list updated');
});

it('names the connection with rejected credentials even when it has no saved models', async () => {
  const empty = provider('provider-id', []);
  empty.metadata.display_name = 'Lab LAN';
  vi.mocked(acpListProviderDetails).mockResolvedValue([provider('p', ['model-A']), empty]);
  vi.mocked(acpRefreshProviderModels).mockImplementation(async id => {
    if (id === empty.name) throw { message: 'private upstream body', data: {
      code: 'custom_provider_invalid_credentials', httpStatus: 401,
    } };
  });
  const user = userEvent.setup();
  setup();
  await openModels(user);
  await user.click(screen.getByRole('button', { name: 'Refresh models' }));
  const notice = await screen.findByRole('alert');
  expect(notice).toHaveTextContent('Lab LAN · HTTP 401');
  expect(notice).toHaveTextContent('The API key was rejected.');
  expect(notice).toHaveTextContent('No saved model list.');
  expect(notice).not.toHaveTextContent('private upstream body');
});

it('distinguishes a failure to read updated lists from a provider refusing the refresh', async () => {
  const user = userEvent.setup();
  setup();
  await openModels(user);
  vi.mocked(acpListProviderDetails).mockRejectedValueOnce(new Error('read failed'));
  await user.click(screen.getByRole('button', { name: 'Refresh models' }));
  const notice = await screen.findByRole('alert');
  expect(notice).toHaveTextContent('Could not read the updated lists.');
  expect(notice).not.toHaveTextContent('of 1 connections');
  expect(screen.getByRole('button', { name: 'model-A', pressed: true })).toBeVisible();
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configModel = 'model-A';
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    provider('p', ['model-A', 'model-B']),
    provider('disabled', ['unavailable'], false),
  ]);
  mocks.change.mockResolvedValue(true);
  vi.mocked(acpRefreshProviderModels).mockResolvedValue();
  vi.mocked(acpReadModelDisplaySettings).mockResolvedValue({
    thinking: { options: ['off', 'medium'], value: 'medium', toggle: true },
    contextWindow: 32768,
    contextSource: 'service',
  });
});
describe('direct model selection', () => {
  it('makes the current chat model the default when its provider differs from the saved selection', async () => {
    mocks.configModel = 'model-B';
    const user = userEvent.setup();
    setup();
    await openModels(user);
    await user.click(await screen.findByRole('button', { name: 'model-A', pressed: true }));
    await waitFor(() => expect(mocks.change).toHaveBeenCalledTimes(1));
    expect(mocks.change.mock.calls[0][1]).toMatchObject({ name: 'model-A', provider: 'p' });
    expect(mocks.change.mock.calls[0][2]).toHaveProperty('updateDefaults', true);
  });
  it('keeps other connections folded and leaves the current selection intact when toggling groups', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      provider('other-key', ['other-model']),
      provider('p', ['model-A', 'model-B']),
    ]);
    const user = userEvent.setup();
    setup();
    await openModels(user);
    expect(await screen.findByRole('button', { name: 'model-A' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const other = screen.getByRole('button', { name: 'other-key (1)' });
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'other-model' })).toBeNull();
    await user.click(other);
    expect(screen.getByRole('button', { name: 'other-model' })).toBeVisible();
    await user.click(other);
    expect(screen.queryByRole('button', { name: 'other-model' })).toBeNull();
    expect(screen.getByRole('button', { name: 'model-A' })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('pins the current model ahead of a long list and expands the remaining models on demand', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      provider('p', [...Array.from({ length: 9 }, (_, index) => `model-${index}`), 'model-A']),
    ]);
    const user = userEvent.setup();
    setup();
    await openModels(user);
    const selected = await screen.findByRole('button', { name: 'model-A' });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'model-8' })).toBeNull();
    expect(screen.getByRole('button', { name: 'model-0' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }));
    expect(screen.getByRole('button', { name: 'model-8' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByRole('button', { name: 'model-8' })).toBeNull();
    expect(selected).toBeVisible();
  });
  it('searches every connection including folded models and switches using the matched connection', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      provider('p', ['model-A']),
      provider(
        'another-key',
        Array.from({ length: 12 }, (_, index) => `remote-${index}`)
      ),
    ]);
    const user = userEvent.setup();
    const view = setup();
    await openModels(user);
    await screen.findByRole('button', { name: 'model-A' });
    const search = screen.getByRole('searchbox', { name: 'Search models or connections' });
    await user.type(search, 'REMOTE-11');
    expect(screen.queryByRole('button', { name: 'model-A' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'remote-11' }));
    await waitFor(() =>
      expect(view.changed).toHaveBeenCalledWith({ model: 'remote-11', provider: 'another-key' })
    );
    await user.clear(search);
    await user.type(search, 'no-such-model');
    expect(screen.getByText('No matching models')).toBeVisible();
    await user.clear(search);
    expect(screen.getByRole('button', { name: 'model-A' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'another-key (12)' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
  it('reads only the current model and never opens a model details card on hover', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('button', { name: 'Thinking effort: On' });
    await openModels(user);
    const target = await screen.findByRole('button', { name: 'model-B' });
    fireEvent.mouseEnter(target);
    fireEvent.mouseMove(target);
    expect(document.querySelector('[data-model-picker-details]')).toBeNull();
    expect(acpReadModelDisplaySettings).toHaveBeenCalledExactlyOnceWith('p', 'model-A', false);
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('keeps the clicked list open after pointer movement and closes on an outside click', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = await openModels(user);
    await screen.findByRole('button', { name: 'model-B' });
    const list = document.querySelector('[data-model-picker-list]')!;
    vi.useFakeTimers();
    try {
      // A newly positioned popup can briefly pass under the stationary pointer.
      fireEvent.mouseOver(list, { relatedTarget: trigger });
      fireEvent.mouseOut(list, { relatedTarget: trigger });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(document.querySelector('[data-model-picker-list]')).toBeVisible();
      expect(screen.getByRole('button', { name: 'model-B' })).toBeVisible();

      fireEvent.mouseOut(trigger, { relatedTarget: document.body });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(document.querySelector('[data-model-picker-list]')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
    await user.click(document.body);
    await waitFor(() => expect(document.querySelector('[data-model-picker-list]')).toBeNull());
  });
  it('opens the effort slider directly and links back to model selection without a details page', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('button', { name: 'Thinking effort: On' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button')).toHaveTextContent('model-A');
    await user.click(await screen.findByRole('button', { name: 'Thinking effort: On' }));
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAttribute('max', '1');
    expect(document.querySelector('[data-model-picker-details]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'model-A' }));
    expect(await screen.findByRole('button', { name: 'model-B' })).toBeVisible();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('opens model selection directly when the model has no thinking controls', async () => {
    vi.mocked(acpReadModelDisplaySettings).mockResolvedValue({
      thinking: { options: [], value: null, toggle: false },
      contextWindow: 32768,
      contextSource: 'service',
    });
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'model-A' }));
    expect(await screen.findByRole('button', { name: 'model-B' })).toBeVisible();
    expect(screen.queryByRole('slider')).toBeNull();
  });
  it('switches with one model click and has no intermediate dialog or agent configuration action', async () => {
    const user = userEvent.setup(),
      view = setup();
    await openModels(user);
    await user.click(await screen.findByRole('button', { name: 'model-B' }));
    await waitFor(() =>
      expect(view.changed).toHaveBeenCalledExactlyOnceWith({ model: 'model-B', provider: 'p' })
    );
    expect(mocks.change).toHaveBeenCalledTimes(1);
    expect(mocks.change.mock.calls[0][0]).toBe('chat');
    expect(mocks.change.mock.calls[0][1]).toMatchObject({ name: 'model-B', provider: 'p' });
    expect(mocks.change.mock.calls[0][2]).toHaveProperty('updateDefaults', true);
    expect(screen.queryByText('Configure agent models')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'model-B' })).toBeVisible();
  });
  it('keeps the old selection and menu when the server rejects a switch', async () => {
    mocks.change.mockResolvedValue(false);
    const user = userEvent.setup(),
      view = setup();
    await openModels(user);
    await user.click(await screen.findByRole('button', { name: 'model-B' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch models');
    expect(screen.getByRole('button', { name: 'model-A' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'unavailable' })).not.toBeInTheDocument();
  });
  it('suppresses concurrent clicks and only publishes a confirmed switch', async () => {
    let resolve!: (value: boolean) => void;
    mocks.change.mockReturnValue(
      new Promise<boolean>((yes) => {
        resolve = yes;
      })
    );
    const user = userEvent.setup(),
      view = setup();
    await openModels(user);
    const target = await screen.findByRole('button', { name: 'model-B' });
    await user.dblClick(target);
    expect(mocks.change).toHaveBeenCalledTimes(1);
    expect(view.changed).not.toHaveBeenCalled();
    resolve(true);
    await waitFor(() => expect(view.changed).toHaveBeenCalledTimes(1));
  });
  it('keeps a late failure visible after closing and reopening the menu, then retries the same selection', async () => {
    let fail!: (value: boolean) => void;
    mocks.change.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        fail = resolve;
      })
    );
    const user = userEvent.setup(),
      view = setup();
    const trigger = await openModels(user);
    await user.click(await screen.findByRole('button', { name: 'model-B' }));
    expect(trigger).toHaveAttribute('aria-busy', 'true');
    await user.click(document.body);
    await waitFor(() => expect(document.querySelector('[data-model-picker-list]')).toBeNull());
    await act(async () => fail(false));
    expect(await screen.findByRole('alert')).toHaveTextContent('Switch failed');
    expect(view.changed).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Switch failed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch models');
    expect(await screen.findByRole('button', { name: 'model-A' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(view.changed).toHaveBeenCalledExactlyOnceWith({ model: 'model-B', provider: 'p' })
    );
    expect(mocks.change).toHaveBeenCalledTimes(2);
    expect(mocks.change.mock.calls[1].slice(0, 2)).toEqual(mocks.change.mock.calls[0].slice(0, 2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-busy', 'false');
  });
  it('shows the safe server diagnostic and allows choosing a different model after a failed switch', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      provider('p', ['model-A', 'model-B', 'model-C']),
    ]);
    mocks.change.mockImplementationOnce(async (_session, _model, options) => {
      options.onError(
        'The model service could not be reached. Check its address and connection, then retry.'
      );
      return false;
    });
    const user = userEvent.setup(),
      view = setup();
    await openModels(user);
    await user.click(await screen.findByRole('button', { name: 'model-B' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model service could not be reached'
    );
    await user.click(screen.getByRole('button', { name: 'model-C' }));
    await waitFor(() =>
      expect(view.changed).toHaveBeenCalledExactlyOnceWith({ model: 'model-C', provider: 'p' })
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('does not publish a switch after the picker has unmounted', async () => {
    let resolve!: (value: boolean) => void;
    mocks.change.mockReturnValueOnce(
      new Promise<boolean>((yes) => {
        resolve = yes;
      })
    );
    const user = userEvent.setup(),
      view = setup();
    await openModels(user);
    await user.click(await screen.findByRole('button', { name: 'model-B' }));
    view.unmount();
    await act(async () => resolve(true));
    expect(view.changed).not.toHaveBeenCalled();
  });
  it('reports model-list load failure and retries without using stale choices', async () => {
    vi.mocked(acpListProviderDetails).mockRejectedValueOnce(new Error('private path'));
    const user = userEvent.setup();
    setup();
    await openModels(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load models.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'model-B' })).toBeVisible();
  });
});
