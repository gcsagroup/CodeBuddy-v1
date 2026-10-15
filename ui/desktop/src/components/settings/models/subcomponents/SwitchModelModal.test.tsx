import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acpListProviderDetails,
  acpReadThinkingEffort,
  acpSaveThinkingEffort,
} from '../../../../acp/providers';
import type { ProviderDetails } from '../../../../types/providers';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { fetchModelReasoning, fetchModelsForProviders } from '../modelInterface';
import { trackModelChanged } from '../../../../utils/analytics';
import { SwitchModelModal } from './SwitchModelModal';
import { shouldShowPredefinedModels } from '../predefinedModelsUtils';
import { applyCodeProDefaultModelTransaction } from '../../../../acp/codeproModelRouting';

const contextMocks = vi.hoisted(() => ({
  changeModel: vi.fn(),
}));

vi.mock('../../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    changeModel: contextMocks.changeModel,
    currentModel: null,
    currentProvider: null,
  }),
}));

vi.mock('../../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpReadThinkingEffort: vi.fn().mockResolvedValue(null),
  acpSaveThinkingEffort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../modelInterface', () => ({
  default: class Model {},
  fetchModelReasoning: vi.fn().mockResolvedValue(false),
  fetchModelsForProviders: vi.fn().mockResolvedValue([]),
  getProviderMetadata: vi.fn().mockResolvedValue({ display_name: 'Provider' }),
}));

vi.mock('../predefinedModelsUtils', () => ({
  getPredefinedModelsFromEnv: vi.fn().mockReturnValue([]),
  shouldShowPredefinedModels: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../../utils/analytics', () => ({
  trackModelChanged: vi.fn(),
}));

vi.mock('../../../../acp/codeproModelRouting', () => ({
  applyCodeProDefaultModelTransaction: vi.fn(
    async (applyModelAndDefaults: () => Promise<boolean>) => ({
      revision: 1,
      status: (await applyModelAndDefaults()) ? 'applied' : 'failed',
    })
  ),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe('SwitchModelModal', () => {
  const enabledProvider = providerDetails('ollama_cloud', true);
  const disabledProvider = providerDetails('zai', false);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpListProviderDetails).mockReset().mockResolvedValue([]);
    vi.mocked(acpReadThinkingEffort).mockReset().mockResolvedValue(null);
    vi.mocked(acpSaveThinkingEffort).mockReset().mockResolvedValue(undefined);
    vi.mocked(fetchModelReasoning).mockReset().mockResolvedValue(false);
    vi.mocked(fetchModelsForProviders).mockReset().mockResolvedValue([]);
    vi.mocked(shouldShowPredefinedModels).mockReset().mockReturnValue(false);
    vi.mocked(applyCodeProDefaultModelTransaction)
      .mockReset()
      .mockImplementation(async (applyModelAndDefaults) => ({
        revision: 1,
        status: (await applyModelAndDefaults()) ? 'applied' : 'failed',
      }));
    contextMocks.changeModel.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderThinkingModal = (sessionId = 'session-1', modelDiscoveryFails = false) => {
    const onClose = vi.fn();
    const onModelSelected = vi.fn();
    vi.mocked(acpListProviderDetails).mockResolvedValue([enabledProvider]);
    vi.mocked(fetchModelReasoning).mockResolvedValue(true);
    vi.mocked(fetchModelsForProviders).mockResolvedValue([
      {
        provider: enabledProvider,
        models: modelDiscoveryFails
          ? []
          : [
              { name: 'reasoner', provider: enabledProvider.name, reasoning: true },
              { name: 'reasoner-2', provider: enabledProvider.name, reasoning: true },
            ],
        error: modelDiscoveryFails ? 'The connection is temporarily unavailable.' : null,
        warning: null,
      },
    ]);

    const view = render(
      <SwitchModelModal
        sessionId={sessionId}
        sessionModel="reasoner"
        sessionProvider={enabledProvider.name}
        onClose={onClose}
        onModelSelected={onModelSelected}
        setView={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );
    return {
      onClose,
      onModelSelected,
      rerenderSession(nextSessionId: string) {
        view.rerender(
          <SwitchModelModal
            sessionId={nextSessionId}
            sessionModel="reasoner"
            sessionProvider={enabledProvider.name}
            onClose={onClose}
            onModelSelected={onModelSelected}
            setView={vi.fn()}
          />
        );
      },
    };
  };

  it('does not show the Goose quick start guide', () => {
    render(<SwitchModelModal sessionId={null} onClose={vi.fn()} setView={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    expect(screen.queryByRole('link', { name: 'Quick start guide' })).not.toBeInTheDocument();
  });

  it('preserves the just-saved selection when editing the current provider', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([enabledProvider]);
    vi.mocked(fetchModelsForProviders).mockResolvedValue([
      {
        provider: enabledProvider,
        models: ['gemini-3.6-flash', 'ollama-dev'].map((name) => ({
          name,
          provider: enabledProvider.name,
        })),
        error: null,
        warning: null,
      },
    ]);
    const user = userEvent.setup();
    render(
      <SwitchModelModal
        sessionId={null}
        initialProvider={enabledProvider.name}
        initialModel="ollama-dev"
        sessionProvider={enabledProvider.name}
        sessionModel="gemini-3.6-flash"
        onClose={vi.fn()}
        setView={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select model' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() =>
      expect(contextMocks.changeModel).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ provider: enabledProvider.name, name: 'ollama-dev' }),
        { onError: expect.any(Function) }
      )
    );
  });

  it.each([
    ['ollama-dev', 'ollama-dev'],
    ['removed-model', 'gemini-3.6-flash'],
  ])(
    'uses the configured default %s only when it is still available',
    async (configured, selected) => {
      const gateway = {
        ...enabledProvider,
        metadata: { ...enabledProvider.metadata, default_model: configured },
      };
      vi.mocked(acpListProviderDetails).mockResolvedValue([gateway]);
      vi.mocked(fetchModelsForProviders).mockResolvedValue([
        {
          provider: gateway,
          models: ['gemini-3.6-flash', 'ollama-dev'].map((name) => ({
            name,
            provider: gateway.name,
          })),
          error: null,
          warning: null,
        },
      ]);
      const user = userEvent.setup();
      render(
        <SwitchModelModal
          sessionId={null}
          initialProvider={gateway.name}
          onClose={vi.fn()}
          setView={vi.fn()}
        />,
        {
          wrapper: IntlTestWrapper,
        }
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Select model' })).toBeEnabled()
      );
      await user.click(screen.getByRole('button', { name: 'Select model' }));
      await waitFor(() =>
        expect(contextMocks.changeModel).toHaveBeenCalledWith(
          null,
          expect.objectContaining({ provider: gateway.name, name: selected }),
          { onError: expect.any(Function) }
        )
      );
    }
  );

  it('does not offer activation-disabled configured providers', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([disabledProvider, enabledProvider]);
    const user = userEvent.setup();

    render(<SwitchModelModal sessionId={null} onClose={vi.fn()} setView={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    await waitFor(() => expect(acpListProviderDetails).toHaveBeenCalled());
    await user.click(screen.getAllByRole('combobox')[0]);

    expect(await screen.findByRole('option', { name: 'ollama_cloud' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'zai' })).not.toBeInTheDocument();
  });

  it('ignores predefined recommendations and shows configured custom connections plus setup action', async () => {
    vi.mocked(shouldShowPredefinedModels).mockReturnValue(true);
    vi.mocked(acpListProviderDetails).mockResolvedValue([enabledProvider]);
    const setView = vi.fn();
    const user = userEvent.setup();

    render(<SwitchModelModal sessionId={null} onClose={vi.fn()} setView={setView} />, {
      wrapper: IntlTestWrapper,
    });

    await waitFor(() => expect(acpListProviderDetails).toHaveBeenCalled());
    await user.click(screen.getAllByRole('combobox')[0]);
    expect(await screen.findByRole('option', { name: 'ollama_cloud' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Use another provider…' })).toBeInTheDocument();
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('shows configured custom connections without mixing in built-in provider catalog entries', async () => {
    const builtInProvider = providerDetails('amazon_bedrock', true, 'Builtin');
    vi.mocked(acpListProviderDetails).mockResolvedValue([enabledProvider, builtInProvider]);
    const user = userEvent.setup();

    render(<SwitchModelModal sessionId={null} onClose={vi.fn()} setView={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    await waitFor(() => expect(acpListProviderDetails).toHaveBeenCalled());
    await user.click(screen.getAllByRole('combobox')[0]);

    expect(await screen.findByRole('option', { name: 'ollama_cloud' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'amazon_bedrock' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Use another provider…' })).toBeInTheDocument();
  });

  it('shows a path-free unavailable state when thinking effort cannot be read', async () => {
    const privatePath = 'C:\\Users\\private\\thinking.yaml';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(acpReadThinkingEffort).mockRejectedValue(new Error(privatePath));

    renderThinkingModal();

    expect(await screen.findByRole('alert')).toHaveTextContent('Thinking effort is unavailable.');
    expect(screen.queryByText('Off - No extended thinking')).not.toBeInTheDocument();
    expect(
      JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...log.mock.calls])
    ).not.toContain(privatePath);
    expect(document.body.textContent).not.toContain(privatePath);
  });

  it('retains the specific model validation error and permits retry', async () => {
    contextMocks.changeModel
      .mockImplementationOnce(async (_session, _model, options) => {
        options.onError('服务已不再提供此模型，请刷新模型列表并选择可用模型。');
        return false;
      })
      .mockResolvedValueOnce(true);
    const { onClose } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');
    await user.click(screen.getByRole('button', { name: 'Select model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('服务已不再提供此模型');
    expect(onClose).not.toHaveBeenCalled();
    expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('does not save thinking or close when the model switch returns false and allows retry', async () => {
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('high');
    contextMocks.changeModel.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { onClose } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to switch models. Try again.'
    );
    expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(acpSaveThinkingEffort).toHaveBeenCalledWith('high');
  });

  it('catches a rejected model switch without leaking its error or closing', async () => {
    const privatePath = 'D:\\secret\\provider.log';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('low');
    contextMocks.changeModel.mockRejectedValue(new Error(privatePath));
    const { onClose } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to switch models. Try again.'
    );
    expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...log.mock.calls])
    ).not.toContain(privatePath);
    expect(document.body.textContent).not.toContain(privatePath);
  });

  it('keeps the modal open and reports safely when thinking persistence fails', async () => {
    const privatePath = 'D:\\secret\\preferences.yaml';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('medium');
    vi.mocked(acpSaveThinkingEffort)
      .mockRejectedValueOnce(new Error(privatePath))
      .mockResolvedValueOnce(undefined);
    const { onClose } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model changed, but thinking effort could not be saved. Try again.'
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...log.mock.calls])
    ).not.toContain(privatePath);
    expect(document.body.textContent).not.toContain(privatePath);
    expect(contextMocks.changeModel).toHaveBeenCalledTimes(1);
    expect(acpSaveThinkingEffort).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('combobox')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(contextMocks.changeModel).toHaveBeenCalledTimes(1);
    expect(acpSaveThinkingEffort).toHaveBeenCalledTimes(2);
    expect(contextMocks.changeModel.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(acpSaveThinkingEffort).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(acpSaveThinkingEffort).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(acpSaveThinkingEffort).mock.invocationCallOrder[1]
    );
  });

  it('changes the model again when the selection identity changes after a thinking failure', async () => {
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('high');
    vi.mocked(acpSaveThinkingEffort)
      .mockRejectedValueOnce(new Error('first save failed'))
      .mockResolvedValueOnce(undefined);
    const { onClose } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await screen.findByRole('alert');
    expect(contextMocks.changeModel).toHaveBeenCalledTimes(1);

    const modelSelect = screen.getAllByRole('combobox')[1];
    await user.click(modelSelect);
    await user.click(await screen.findByRole('option', { name: 'reasoner-2' }));
    await user.click(screen.getByRole('button', { name: 'Select model' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(contextMocks.changeModel).toHaveBeenCalledTimes(2);
    expect(contextMocks.changeModel.mock.calls[1][1]).toMatchObject({
      name: 'reasoner-2',
      provider: enabledProvider.name,
    });
    expect(acpSaveThinkingEffort).toHaveBeenNthCalledWith(2, 'high');
  });

  it('does not reuse a committed model from another session when retrying thinking persistence', async () => {
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('high');
    vi.mocked(acpSaveThinkingEffort)
      .mockRejectedValueOnce(new Error('first save failed'))
      .mockResolvedValueOnce(undefined);
    const { onClose, onModelSelected, rerenderSession } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await screen.findByRole('alert');
    expect(contextMocks.changeModel).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ name: 'reasoner' }),
      { onError: expect.any(Function) }
    );

    rerenderSession('session-2');
    await user.click(screen.getByRole('button', { name: 'Select model' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(contextMocks.changeModel).toHaveBeenCalledTimes(2);
    expect(contextMocks.changeModel).toHaveBeenNthCalledWith(
      2,
      'session-2',
      expect.objectContaining({ name: 'reasoner' }),
      { onError: expect.any(Function) }
    );
    expect(acpSaveThinkingEffort).toHaveBeenNthCalledWith(2, 'high');
    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(trackModelChanged).toHaveBeenCalledTimes(1);
  });

  it('freezes identity and all close paths while a submission is in flight', async () => {
    const modelSwitch = deferred<boolean>();
    const thinkingSave = deferred<void>();
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('max');
    contextMocks.changeModel.mockReturnValue(modelSwitch.promise);
    vi.mocked(acpSaveThinkingEffort).mockReturnValue(thinkingSave.promise);
    const { onClose, onModelSelected } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(contextMocks.changeModel).toHaveBeenCalledTimes(1));

    const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
    expect(comboboxes.length).toBeGreaterThan(0);
    for (const combobox of comboboxes) {
      expect(combobox).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();

    modelSwitch.resolve(true);
    await waitFor(() => expect(acpSaveThinkingEffort).toHaveBeenCalledWith('max'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    thinkingSave.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(trackModelChanged).toHaveBeenCalledTimes(1);
  });

  it('freezes a custom model draft while its model switch is in flight', async () => {
    const modelSwitch = deferred<boolean>();
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('medium');
    contextMocks.changeModel.mockReturnValue(modelSwitch.promise);
    const { onClose } = renderThinkingModal('session-1', true);
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    const customInput = await screen.findByPlaceholderText('Type model name here');
    await user.clear(customInput);
    await user.type(customInput, 'private-reasoner');
    await waitFor(() => expect(screen.getByText('Thinking Effort')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(contextMocks.changeModel).toHaveBeenCalledTimes(1));
    expect(customInput).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    modelSwitch.resolve(false);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to switch models. Try again.'
    );
    expect(customInput).toBeEnabled();
  });

  it('ignores an old in-flight completion after the session target changes', async () => {
    const oldSwitch = deferred<boolean>();
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('high');
    contextMocks.changeModel.mockReturnValueOnce(oldSwitch.promise).mockResolvedValueOnce(true);
    const { onClose, onModelSelected, rerenderSession } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(contextMocks.changeModel).toHaveBeenCalledTimes(1));
    rerenderSession('session-2');
    oldSwitch.resolve(true);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Select model' })).toBeEnabled());
    expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
    expect(onModelSelected).not.toHaveBeenCalled();
    expect(trackModelChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(contextMocks.changeModel).toHaveBeenNthCalledWith(
      2,
      'session-2',
      expect.objectContaining({ name: 'reasoner' }),
      { onError: expect.any(Function) }
    );
    expect(acpSaveThinkingEffort).toHaveBeenCalledTimes(1);
    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(trackModelChanged).toHaveBeenCalledTimes(1);
  });

  it('awaits model switching, then thinking persistence, and closes only after both succeed', async () => {
    const modelSwitch = deferred<boolean>();
    const thinkingSave = deferred<void>();
    vi.mocked(acpReadThinkingEffort).mockResolvedValue('max');
    contextMocks.changeModel.mockReturnValue(modelSwitch.promise);
    vi.mocked(acpSaveThinkingEffort).mockReturnValue(thinkingSave.promise);
    const { onClose, onModelSelected } = renderThinkingModal();
    const user = userEvent.setup();
    await screen.findByText('Thinking Effort');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() => expect(contextMocks.changeModel).toHaveBeenCalledTimes(1));
    expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    modelSwitch.resolve(true);
    await waitFor(() => expect(acpSaveThinkingEffort).toHaveBeenCalledWith('max'));
    expect(onClose).not.toHaveBeenCalled();

    thinkingSave.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(trackModelChanged).toHaveBeenCalledTimes(1);
  });

  it('makes every CodePro agent follow the newly selected conversation model', async () => {
    const onClose = vi.fn();
    vi.mocked(acpListProviderDetails).mockResolvedValue([enabledProvider]);
    vi.mocked(fetchModelsForProviders).mockResolvedValue([
      {
        provider: enabledProvider,
        models: [{ name: 'reasoner', provider: enabledProvider.name, reasoning: false }],
        error: null,
        warning: null,
      },
    ]);
    const user = userEvent.setup();

    render(
      <SwitchModelModal
        sessionId="session-1"
        sessionModel="reasoner"
        sessionProvider={enabledProvider.name}
        onClose={onClose}
        setView={vi.fn()}
        applyToAllAgents
      />,
      { wrapper: IntlTestWrapper }
    );

    await waitFor(() => expect(fetchModelsForProviders).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Select model' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(applyCodeProDefaultModelTransaction).toHaveBeenCalledTimes(1);
    expect(contextMocks.changeModel).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ name: 'reasoner', provider: enabledProvider.name }),
      { updateDefaults: true, onError: expect.any(Function) }
    );
  });
});

function providerDetails(
  name: string,
  activationEnabled: boolean,
  providerType: ProviderDetails['provider_type'] = 'Custom'
): ProviderDetails {
  return {
    name,
    is_configured: true,
    provider_type: providerType,
    metadata: {
      name,
      display_name: name,
      description: '',
      default_model: '',
      model_doc_link: '',
      known_models: [],
      setup_steps: [],
      config_keys: activationEnabled
        ? []
        : [
            {
              name: 'API_KEY',
              oauth_flow: false,
              primary: true,
              required: true,
              secret: true,
              credential_validation_supported: false,
              credential_validation_unavailable_reason: 'Provider activation is disabled',
            },
          ],
    },
  };
}
