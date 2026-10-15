import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpSaveProviderConfig } from '../../../../../../acp/providers';
import { providerConfigSubmitHandler } from './DefaultSubmitHandler';

vi.mock('../../../../../../acp/providers', () => ({
  acpSaveProviderConfig: vi.fn(),
}));

const openai = {
  name: 'openai',
  metadata: {
    config_keys: [
      { name: 'OPENAI_API_KEY' },
      { name: 'OPENAI_HOST', default: 'https://api.openai.com' },
      { name: 'OPENAI_BASE_URL' },
    ],
  },
};

describe('providerConfigSubmitHandler OpenAI endpoint selector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits only a user-selected base URL and atomically clears the host selector', async () => {
    await providerConfigSubmitHandler(openai, {
      OPENAI_API_KEY: 'candidate-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:3000/v1',
    });

    expect(acpSaveProviderConfig).toHaveBeenCalledWith(
      'openai',
      [
        { key: 'OPENAI_API_KEY', value: 'candidate-key' },
        { key: 'OPENAI_BASE_URL', value: 'http://127.0.0.1:3000/v1' },
      ],
      ['OPENAI_HOST']
    );
  });

  it('submits only a selected host and atomically clears the base URL selector', async () => {
    await providerConfigSubmitHandler(openai, {
      OPENAI_HOST: 'https://api.openai.com',
    });

    expect(acpSaveProviderConfig).toHaveBeenCalledWith(
      'openai',
      [{ key: 'OPENAI_HOST', value: 'https://api.openai.com' }],
      ['OPENAI_BASE_URL']
    );
  });
});
