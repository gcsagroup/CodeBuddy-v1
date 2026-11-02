import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeSettingsDto } from '@aaif/goose-sdk';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import {
  acpListProviderDetails,
  acpReadDefaults,
  acpReadModelDisplaySettings,
  acpSaveDefaults,
  acpSaveThinkingEffort,
} from '../../../acp/providers';
import { acpChatSessionStore } from '../../../acp/chatSessionStore';
import type { ProviderDetails } from '../../../types/providers';
import { acpGetSessionListItem } from '../../../acp/sessions';
import { ScheduleModelControls } from '../ScheduleModelControls';

vi.mock('../../../acp/sessions', () => ({ acpGetSessionListItem: vi.fn() }));

vi.mock('../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpReadDefaults: vi.fn(),
  acpReadModelDisplaySettings: vi.fn(),
  acpSaveDefaults: vi.fn(),
  acpSaveThinkingEffort: vi.fn(),
}));
vi.mock('../../../acp/chatSessionStore', () => ({ acpChatSessionStore: { getSnapshot: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.mocked(acpReadDefaults).mockResolvedValue({
    providerId: 'fixture',
    modelId: 'reasoning-model',
  });
  vi.mocked(acpReadModelDisplaySettings).mockImplementation(async (_provider, model) => ({
    contextWindow: null,
    contextSource: null,
    thinking:
      model === 'plain-model'
        ? { options: [], value: null, toggle: false }
        : { options: ['low', 'high'], value: 'low', toggle: false },
  }));
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    {
      name: 'fixture',
      is_configured: true,
      provider_type: 'Custom',
      metadata: {
        display_name: 'Fixture connection',
        default_model: 'reasoning-model',
        description: 'fixture',
        model_doc_link: '',
        name: 'fixture',
        config_keys: [],
        known_models: [
          { name: 'reasoning-model', context_limit: 100000 },
          { name: 'plain-model', context_limit: 100000 },
        ],
      },
    } as ProviderDetails,
  ]);
  vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(undefined);
});

describe('automatic task model settings', () => {
  it('selects only declared effort levels into the task draft and clears them when changing to a non-reasoning model', async () => {
    const changed = vi.fn();
    function Draft() {
      const [value, setValue] = useState<RecipeSettingsDto>();
      return (
        <ScheduleModelControls
          value={value}
          onChange={(next) => {
            setValue(next);
            changed(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Draft />, { wrapper: IntlTestWrapper });
    await user.click(await screen.findByRole('button', { name: 'Thinking effort: Low' }));
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'low',
      'high',
    ]);
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith({
        goose_provider: 'fixture',
        goose_model: 'reasoning-model',
        goose_thinking_effort: 'high',
      })
    );
    expect(acpListProviderDetails).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Model' }));
    await user.click(await screen.findByRole('button', { name: 'plain-model' }));
    await screen.findByText('No verified controls');
    expect(changed).toHaveBeenLastCalledWith({
      goose_provider: 'fixture',
      goose_model: 'plain-model',
      goose_thinking_effort: null,
    });
    expect(acpSaveDefaults).not.toHaveBeenCalled();
    expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
  });

  it('reads an explicitly chosen chat without loading its history or changing global defaults', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(undefined);
    vi.mocked(acpGetSessionListItem).mockResolvedValue({
      id: 'unopened-chat',
      name: 'Review',
      providerId: 'chosen-provider',
      modelId: 'chosen-model',
      workingDir: '/fixture',
      createdAt: '',
      updatedAt: '',
      messageCount: 1,
    });
    render(
      <ScheduleModelControls value={undefined} onChange={vi.fn()} followChatId="unopened-chat" />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByText('chosen-model')).toBeInTheDocument();
    expect(acpGetSessionListItem).toHaveBeenCalledWith('unopened-chat');
    expect(acpReadDefaults).not.toHaveBeenCalled();
    expect(acpSaveDefaults).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled();
  });

  it('inherits the bound chat without offering a model or effort override', async () => {
    vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue({
      session: { provider_name: 'chat-provider', model_config: { model_name: 'chat-model' } },
    } as ReturnType<typeof acpChatSessionStore.getSnapshot>);
    const changed = vi.fn();
    render(
      <ScheduleModelControls value={undefined} onChange={changed} followChatId="existing-chat" />,
      { wrapper: IntlTestWrapper }
    );
    await waitFor(() =>
      expect(acpReadModelDisplaySettings).toHaveBeenCalledWith('chat-provider', 'chat-model')
    );
    expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Thinking effort: Low' })).toBeDisabled();
    expect(acpReadDefaults).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
