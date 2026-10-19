import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import ModelsSection from './ModelsSection';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  list: vi.fn(),
  modelDisplay: vi.fn(),
  providerDisplay: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../ModelAndProviderContext', () => ({
  modelAndProviderMessages: {
    selectModel: { id: 'test.selectModel', defaultMessage: 'Select Model' },
    unknownProviderTitle: { id: 'test.unknownTitle', defaultMessage: 'Provider name lookup' },
    unknownProviderMsg: { id: 'test.unknownMessage', defaultMessage: 'Unknown provider in config' },
  },
  useModelAndProvider: () => ({
    currentModel: 'first-model',
    currentProvider: 'custom_codebuddy_default',
    getCurrentModelDisplayName: mocks.modelDisplay,
    getCurrentProviderDisplayName: mocks.providerDisplay,
  }),
}));
vi.mock('../../../acp/providers', () => ({
  acpReadDefaults: mocks.read,
  acpListProviderDetails: mocks.list,
}));
vi.mock('../../../toasts', () => ({ toastError: mocks.toastError }));
vi.mock('./subcomponents/ModelSettingsButtons', () => ({
  default: () => <div>model-settings-buttons</div>,
}));

describe('ModelsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue({
      providerId: 'custom_codebuddy_default',
      modelId: 'first-model',
    });
    mocks.list.mockResolvedValue([]);
    mocks.modelDisplay.mockResolvedValue('first-model');
    mocks.providerDisplay.mockResolvedValue('My model connection');
  });

  it('does not render the removed provider reset area', async () => {
    render(<ModelsSection setView={vi.fn()} />, { wrapper: IntlTestWrapper });
    await waitFor(() => expect(screen.getByText('first-model')).toBeInTheDocument());
    expect(screen.queryByText('Reset Provider and Model')).not.toBeInTheDocument();
  });

  it.each([
    { providerId: null, modelId: null },
    { providerId: 'custom_codebuddy_default', modelId: null },
  ])('shows normal model selection without an unknown-provider error for %j', async (defaults) => {
    mocks.read.mockResolvedValue(defaults);
    render(<ModelsSection setView={vi.fn()} />, { wrapper: IntlTestWrapper });
    expect(await screen.findByText('Select Model')).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.providerDisplay).not.toHaveBeenCalled();
  });

  it('still reports a nonempty saved provider that cannot be found', async () => {
    mocks.providerDisplay.mockResolvedValue('');
    render(<ModelsSection setView={vi.fn()} />, { wrapper: IntlTestWrapper });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.list).toHaveBeenCalled();
  });
});
