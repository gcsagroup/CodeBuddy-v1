import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import ModelsSection from './ModelsSection';

vi.mock('../../ModelAndProviderContext', () => ({
  modelAndProviderMessages: {},
  useModelAndProvider: () => ({
    currentModel: 'first-model',
    currentProvider: 'custom_codebuddy_default',
    getCurrentModelDisplayName: vi.fn().mockResolvedValue('first-model'),
    getCurrentProviderDisplayName: vi.fn().mockResolvedValue('CodeBuddy LAN'),
  }),
}));

vi.mock('../../../acp/providers', () => ({
  acpReadDefaults: vi.fn(),
  acpListProviderDetails: vi.fn(),
}));

vi.mock('./subcomponents/ModelSettingsButtons', () => ({
  default: () => <div>model-settings-buttons</div>,
}));

describe('ModelsSection', () => {
  it('does not render the removed provider reset area', async () => {
    render(<ModelsSection setView={vi.fn()} />, { wrapper: IntlTestWrapper });

    await waitFor(() => expect(screen.getByText('first-model')).toBeInTheDocument());
    expect(screen.queryByText('Reset Provider and Model')).not.toBeInTheDocument();
  });
});
