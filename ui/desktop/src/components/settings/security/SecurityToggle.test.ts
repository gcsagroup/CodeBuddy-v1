import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfig } from '../../ConfigContext';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { SecurityToggle } from './SecurityToggle';

vi.mock('../../ConfigContext', () => ({
  useConfig: vi.fn(),
}));

describe('SecurityToggle token persistence', () => {
  const upsert = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConfig).mockReturnValue({
      config: {
        SECURITY_PROMPT_ENABLED: true,
        SECURITY_PROMPT_CLASSIFIER_ENABLED: true,
        SECURITY_PROMPT_CLASSIFIER_TOKEN: 'existing-prompt-token',
        SECURITY_COMMAND_CLASSIFIER_ENABLED: true,
        SECURITY_COMMAND_CLASSIFIER_TOKEN: 'existing-command-token',
      },
      upsert,
    } as unknown as ReturnType<typeof useConfig>);
  });

  const renderToggle = () =>
    render(createElement(SecurityToggle), {
      wrapper: IntlTestWrapper,
    });

  it.each(['', '   '])(
    'does not overwrite either stored token when blur receives %j',
    async (value) => {
      renderToggle();

      const commandToken = screen.getByPlaceholderText('token...');
      const promptToken = screen.getByPlaceholderText('hf_...');
      fireEvent.change(commandToken, { target: { value } });
      fireEvent.blur(commandToken);
      fireEvent.change(promptToken, { target: { value } });
      fireEvent.blur(promptToken);

      await waitFor(() =>
        expect(upsert.mock.calls.filter(([, , secret]) => secret === true)).toEqual([])
      );
    }
  );

  it('persists non-empty token values without changing their existing value semantics', async () => {
    renderToggle();

    const commandToken = screen.getByPlaceholderText('token...');
    const promptToken = screen.getByPlaceholderText('hf_...');
    fireEvent.change(commandToken, { target: { value: '  command-token  ' } });
    fireEvent.blur(commandToken);
    fireEvent.change(promptToken, { target: { value: '  prompt-token  ' } });
    fireEvent.blur(promptToken);

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledWith(
        'SECURITY_COMMAND_CLASSIFIER_TOKEN',
        '  command-token  ',
        true
      );
      expect(upsert).toHaveBeenCalledWith(
        'SECURITY_PROMPT_CLASSIFIER_TOKEN',
        '  prompt-token  ',
        true
      );
    });
  });
});
