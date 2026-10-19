import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { acpReadModelDisplaySettings, acpListProviderDetails } from '../../../../acp/providers';
import type { ProviderDetails } from '../../../../types/providers';
import ModelsBottomBar from './ModelsBottomBar';

const mocks = vi.hoisted(() => ({ change: vi.fn(), navigate: vi.fn() }));
vi.mock('../../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    currentModel: 'model-A',
    currentProvider: 'p',
    changeModel: mocks.change,
  }),
}));
vi.mock('../../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpReadModelDisplaySettings: vi.fn(),
}));
vi.mock('../../../ThinkingEffortPicker', () => ({ ModelThinkingMenu: () => null }));
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
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    provider('p', ['model-A', 'model-B']),
    provider('disabled', ['unavailable'], false),
  ]);
  mocks.change.mockResolvedValue(true);
  vi.mocked(acpReadModelDisplaySettings).mockResolvedValue({
    thinking: { options: ['off', 'medium'], value: 'medium', toggle: true },
    contextWindow: 32768,
    contextSource: 'service',
  });
});
describe('direct model selection', () => {
  it('keeps the clicked list open after pointer movement and closes on an outside click', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole('button', { name: 'Select or change model' });
    await user.click(trigger);
    await screen.findByRole('button', { name: 'model-B' });
    const list = document.querySelector('[data-model-picker-list]')!;
    vi.useFakeTimers();
    try {
      // A newly positioned popup can briefly pass under the stationary pointer.
      fireEvent.mouseOver(list, { relatedTarget: trigger });
      fireEvent.mouseOut(list, { relatedTarget: trigger });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: 'model-B' })).toBeVisible();

      fireEvent.mouseOut(trigger, { relatedTarget: document.body });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    } finally {
      vi.useRealTimers();
    }
    await user.click(document.body);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });
  it('opens the list first and only shows model details after hover', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(acpReadModelDisplaySettings).toHaveBeenCalledWith('p', 'model-B'));
    await user.click(screen.getByRole('button', { name: 'Select or change model' }));
    const target = await screen.findByRole('button', { name: 'model-B' });
    expect(document.querySelector('[data-model-picker-details]')).toBeNull();
    // Layout alone can generate enter/leave events when a popup is positioned.
    fireEvent.mouseEnter(target);
    expect(document.querySelector('[data-model-picker-details]')).toBeNull();
    fireEvent.mouseMove(target);
    await waitFor(() =>
      expect(document.querySelector('[data-model-picker-details]')).toHaveTextContent('model-B')
    );
    await user.click(target);
    expect(document.querySelector('[data-model-picker-details]')).not.toBeNull();
    fireEvent.mouseLeave(target);
    await waitFor(() => expect(document.querySelector('[data-model-picker-details]')).toBeNull());
    expect(screen.getByRole('button', { name: 'model-B' })).toBeVisible();
  });
  it('switches with one model click and has no intermediate dialog or agent configuration action', async () => {
    const user = userEvent.setup(),
      view = setup();
    await user.click(screen.getByRole('button', { name: 'Select or change model' }));
    await user.click(await screen.findByRole('button', { name: 'model-B' }));
    await waitFor(() =>
      expect(view.changed).toHaveBeenCalledExactlyOnceWith({ model: 'model-B', provider: 'p' })
    );
    expect(mocks.change).toHaveBeenCalledTimes(1);
    expect(mocks.change.mock.calls[0][0]).toBe('chat');
    expect(mocks.change.mock.calls[0][1]).toMatchObject({ name: 'model-B', provider: 'p' });
    expect(mocks.change.mock.calls[0][2]).not.toHaveProperty('updateDefaults');
    expect(screen.queryByText('Configure agent models')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'model-B' })).toBeVisible();
  });
  it('keeps the old selection and menu when the server rejects a switch', async () => {
    mocks.change.mockResolvedValue(false);
    const user = userEvent.setup(),
      view = setup();
    await user.click(screen.getByRole('button', { name: 'Select or change model' }));
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
    await user.click(screen.getByRole('button', { name: 'Select or change model' }));
    const target = await screen.findByRole('button', { name: 'model-B' });
    await user.dblClick(target);
    expect(mocks.change).toHaveBeenCalledTimes(1);
    expect(view.changed).not.toHaveBeenCalled();
    resolve(true);
    await waitFor(() => expect(view.changed).toHaveBeenCalledTimes(1));
  });
  it('reports model-list load failure and retries without using stale choices', async () => {
    vi.mocked(acpListProviderDetails)
      .mockRejectedValueOnce(new Error('private path'))
      .mockRejectedValueOnce(new Error('private path'));
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Select or change model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load models.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'model-B' })).toBeVisible();
  });
});
