import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import {
  readCodeProModelRouting,
  saveCodeProModelRouting,
  DISABLED_CODEPRO_MODEL_ROUTING,
} from '../../../acp/codeproModelRouting';
import type { ProviderDetails } from '../../../types/providers';
import VisionSettings from './VisionSettings';
vi.mock('../../../../../../runtime/default-model.json', () => ({
  default: {
    providerId: 'custom_codebuddy_lan',
    modelId: 'fixture-chat-model',
    visionModelId: 'CUA-S1-Qwen3.5-4B',
  },
}));
vi.mock('../../../acp/codeproModelRouting', async (original) => ({
  ...(await original<typeof import('../../../acp/codeproModelRouting')>()),
  readCodeProModelRouting: vi.fn(),
  saveCodeProModelRouting: vi.fn(),
}));
it('offers the built-in vision model to an existing connection and saves only the intended route', async () => {
  const existing = { ...DISABLED_CODEPRO_MODEL_ROUTING, maxParallelCoders: 3 };
  vi.mocked(readCodeProModelRouting).mockResolvedValue(existing);
  const providers = [
    { name: 'custom_codebuddy_lan', metadata: { display_name: 'CodeBuddy LAN', known_models: [] } },
  ] as unknown as ProviderDetails[];
  render(<VisionSettings providers={providers} />, {
    wrapper: IntlTestWrapper,
  });
  fireEvent.click(await screen.findByRole('radio', { name: 'Dedicated model' }));
  expect(screen.getByRole('option', { name: /CUA-S1-Qwen3.5-4B/ })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() =>
    expect(saveCodeProModelRouting).toHaveBeenCalledWith({
      ...existing,
      visionRoute: {
        providerId: 'custom_codebuddy_lan',
        modelId: 'CUA-S1-Qwen3.5-4B',
        mode: 'always',
        enabled: true,
      },
    })
  );
  expect(screen.queryByText('Advanced image capabilities')).toBeNull();
  expect(screen.queryByRole('button', { name: /more models/i })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Main model only' }));
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }));
  expect(screen.getByRole('combobox')).toHaveValue(JSON.stringify(['custom_codebuddy_lan', 'CUA-S1-Qwen3.5-4B']));
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
});
