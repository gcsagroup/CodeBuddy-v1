import { useState } from 'react';
import { IntlProvider } from 'react-intl';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpReadProviderConfig } from '../../../../../../acp/providers';
import type { ProviderDetails } from '../../../../../../types/providers';
import DefaultProviderSetupForm, { type ConfigInput } from './DefaultProviderSetupForm';

vi.mock('../../../../../../acp/providers', () => ({
  acpReadProviderConfig: vi.fn(),
}));

const openai: ProviderDetails = {
  name: 'openai',
  is_configured: true,
  provider_type: 'Builtin',
  metadata: {
    name: 'openai',
    display_name: 'OpenAI',
    description: 'OpenAI',
    default_model: 'gpt-4o',
    known_models: [],
    model_doc_link: '',
    setup_steps: [],
    config_keys: [
      {
        name: 'OPENAI_HOST',
        required: false,
        secret: false,
        default: 'https://api.openai.com',
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
      {
        name: 'OPENAI_BASE_URL',
        required: false,
        secret: false,
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
    ],
  },
};

function Harness() {
  const [values, setValues] = useState<Record<string, ConfigInput>>({
    OPENAI_HOST: { value: 'https://stale-host.invalid' },
  });
  return (
    <IntlProvider locale="en" messages={{}}>
      <DefaultProviderSetupForm
        configValues={values}
        setConfigValues={setValues}
        provider={openai}
        validationErrors={{}}
      />
      <output data-testid="state">{JSON.stringify(values)}</output>
    </IntlProvider>
  );
}

describe('DefaultProviderSetupForm OpenAI endpoint selector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces stale selector state with the persisted selector and clears the alternate on edit', async () => {
    vi.mocked(acpReadProviderConfig).mockResolvedValue([
      { key: 'OPENAI_HOST', required: false, isSecret: false, isSet: false, value: null },
      {
        key: 'OPENAI_BASE_URL',
        required: false,
        isSecret: false,
        isSet: true,
        value: 'http://127.0.0.1:3000/v1',
      },
    ]);
    const user = userEvent.setup();
    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByTestId('state').textContent).toContain('http://127.0.0.1:3000/v1')
    );
    expect(screen.getByTestId('state').textContent).not.toContain('stale-host.invalid');

    const inputs = await screen.findAllByRole('textbox');
    await user.type(inputs[0], 'https://api.openai.com');
    const state = JSON.parse(screen.getByTestId('state').textContent ?? '{}');
    expect(state.OPENAI_HOST.value).toBe('https://api.openai.com');
    expect(state.OPENAI_BASE_URL.value).toBe('');
  });
});
