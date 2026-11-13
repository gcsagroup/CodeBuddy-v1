import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Model from './settings/models/modelInterface';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ModelAndProviderProvider, useModelAndProvider } from './ModelAndProviderContext';

const mocks = vi.hoisted(() => ({
  acpReadDefaults: vi.fn(),
  acpSaveDefaults: vi.fn(),
  acpSetSessionProviderModel: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  getSnapshot: vi.fn(),
  setSessionMetadata: vi.fn(),
}));

vi.mock('../acp/providers', () => ({
  acpReadDefaults: mocks.acpReadDefaults,
  acpSaveDefaults: mocks.acpSaveDefaults,
  acpSetSessionProviderModel: mocks.acpSetSessionProviderModel,
}));

vi.mock('../acp/chatSessionStore', () => ({
  acpChatSessionStore: { getSnapshot: mocks.getSnapshot },
  acpChatSessionActions: { setSessionMetadata: mocks.setSessionMetadata },
}));

vi.mock('../toasts', () => ({
  toastError: mocks.toastError,
  toastSuccess: mocks.toastSuccess,
}));

function ChangeModelHarness({
  sessionId,
  updateDefaults = false,
}: {
  sessionId: string | null;
  updateDefaults?: boolean;
}) {
  const { changeModel } = useModelAndProvider();
  const [result, setResult] = useState('pending');
  const [error, setError] = useState('');
  const requestedModel = {
    name: 'reasoner',
    provider: 'ollama_cloud',
  } as Model;

  return (
    <>
      <button
        onClick={() => {
          void changeModel(sessionId, requestedModel, { updateDefaults, onError: setError }).then(
            (changed) => {
              setResult(String(changed));
            }
          );
        }}
      >
        change model
      </button>
      <output aria-label="change result">{result}</output>
      <p aria-label="change error">{error}</p>
    </>
  );
}

describe('ModelAndProviderContext changeModel failure boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });
    mocks.acpSaveDefaults.mockResolvedValue(undefined);
    mocks.acpSetSessionProviderModel.mockResolvedValue({
      providerId: 'ollama_cloud',
      modelId: 'reasoner',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['agent', 'session-1'],
    ['config', null],
  ] as const)(
    'returns false with fixed path-free diagnostics when the %s phase rejects',
    async (phase, sessionId) => {
      const privatePath = `C:\\Users\\private\\${phase}-failure.yaml`;
      if (phase === 'agent') {
        mocks.acpSetSessionProviderModel.mockRejectedValue(new Error(privatePath));
      } else {
        mocks.acpSaveDefaults.mockRejectedValue(new Error(privatePath));
      }
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const user = userEvent.setup();

      render(
        <ModelAndProviderProvider>
          <ChangeModelHarness sessionId={sessionId} />
        </ModelAndProviderProvider>,
        { wrapper: IntlTestWrapper }
      );
      await user.click(screen.getByRole('button', { name: 'change model' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
      expect(screen.getByLabelText('change error')).toHaveTextContent(
        'Unable to switch models. Try again.'
      );
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(`Unable to change model during the ${phase} step.`);

      const observableOutput = JSON.stringify({
        toast: mocks.toastError.mock.calls,
        console: [...error.mock.calls, ...warn.mock.calls, ...log.mock.calls],
        dom: document.body.textContent,
      });
      expect(observableOutput).not.toContain(privatePath);
    }
  );

  it.each([
    ['custom_provider_model_unavailable', 'This model is no longer served by the provider.'],
    ['custom_provider_endpoint_unreachable', 'The model service could not be reached.'],
    ['custom_provider_invalid_credentials', 'The model service rejected or requires credentials.'],
  ])('shows a localized safe diagnostic for %s', async (code, expected) => {
    mocks.acpSetSessionProviderModel.mockRejectedValue({
      message: 'Invalid params',
      data: { code, message: 'private token and path' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ModelAndProviderProvider>
        <ChangeModelHarness sessionId="session-1" />
      </ModelAndProviderProvider>,
      { wrapper: IntlTestWrapper }
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'change model' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
    expect(screen.getByLabelText('change error')).toHaveTextContent(expected);
    expect(screen.getByLabelText('change error')).not.toHaveTextContent('private token');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.acpSaveDefaults).not.toHaveBeenCalled();
    expect(mocks.setSessionMetadata).not.toHaveBeenCalled();
  });

  it('persists a session selection as the shared default when all CodePro agents must follow it', async () => {
    const user = userEvent.setup();
    render(
      <ModelAndProviderProvider>
        <ChangeModelHarness sessionId="session-1" updateDefaults />
      </ModelAndProviderProvider>,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByRole('button', { name: 'change model' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));
    expect(mocks.acpSetSessionProviderModel).toHaveBeenCalledWith(
      'session-1',
      'ollama_cloud',
      'reasoner',
      null
    );
    expect(mocks.acpSaveDefaults).toHaveBeenCalledWith('ollama_cloud', 'reasoner');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.getByLabelText('change error')).toBeEmptyDOMElement();
  });

  it('changes only the active session without success or error toasts', async () => {
    render(
      <ModelAndProviderProvider>
        <ChangeModelHarness sessionId="session-1" />
      </ModelAndProviderProvider>,
      { wrapper: IntlTestWrapper }
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'change model' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));
    expect(mocks.acpSaveDefaults).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('shows useful safe model-switch diagnosis without provider payloads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.acpSetSessionProviderModel.mockRejectedValueOnce({
      message: 'PRIVATE_MODEL_ERROR',
      data: {
        code: 'custom_provider_invalid_credentials',
        diagnostic: {
          code: 'custom_provider_invalid_credentials',
          httpStatus: 401,
          payload: 'PRIVATE_MODEL_ERROR',
        },
      },
    });
    render(
      <ModelAndProviderProvider>
        <ChangeModelHarness sessionId="session-1" />
      </ModelAndProviderProvider>,
      { wrapper: IntlTestWrapper }
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'change model' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
    expect(screen.getByLabelText('change error')).toHaveTextContent('HTTP 401');
    expect(screen.getByLabelText('change error')).not.toHaveTextContent('PRIVATE_MODEL_ERROR');
    expect(mocks.acpSaveDefaults).not.toHaveBeenCalled();
  });

  it('keeps the actionable stop-before-switching refusal instead of advising a network retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.acpSetSessionProviderModel.mockRejectedValueOnce({
      message: 'PRIVATE',
      data: {
        code: 'SESSION_BUSY',
        diagnostic: { code: 'SESSION_BUSY' },
      },
    });
    render(
      <ModelAndProviderProvider>
        <ChangeModelHarness sessionId="session-1" />
      </ModelAndProviderProvider>,
      { wrapper: IntlTestWrapper }
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'change model' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
    expect(screen.getByLabelText('change error')).toHaveTextContent('Stop the current turn');
    expect(screen.getByLabelText('change error')).not.toHaveTextContent('PRIVATE');
    expect(mocks.acpSaveDefaults).not.toHaveBeenCalled();
  });

  it('rolls the session back when shared default persistence fails after session mutation', async () => {
    mocks.acpReadDefaults.mockResolvedValue({
      providerId: 'previous-provider',
      modelId: 'previous-model',
    });
    mocks.getSnapshot.mockReturnValue({
      session: {
        id: 'session-1',
        provider_name: 'previous-provider',
        model_config: { model_name: 'previous-model', toolshim: false },
      },
    });
    mocks.acpSetSessionProviderModel
      .mockResolvedValueOnce({ providerId: 'ollama_cloud', modelId: 'reasoner' })
      .mockResolvedValueOnce({ providerId: 'previous-provider', modelId: 'previous-model' });
    mocks.acpSaveDefaults.mockRejectedValueOnce(new Error('config write failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(
      <ModelAndProviderProvider>
        <ChangeModelHarness sessionId="session-1" updateDefaults />
      </ModelAndProviderProvider>,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: 'change model' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
    expect(mocks.acpSetSessionProviderModel).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'previous-provider',
      'previous-model',
      null
    );
    expect(mocks.setSessionMetadata).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({
        provider_name: 'previous-provider',
        model_config: expect.objectContaining({ model_name: 'previous-model' }),
      })
    );
  });
});
