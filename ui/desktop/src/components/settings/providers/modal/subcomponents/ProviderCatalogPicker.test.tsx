import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderTemplateCatalogEntryDto, ProviderTemplateDto } from '@aaif/goose-sdk';
import {
  acpGetProviderTemplate,
  acpListProviderCatalogEntries,
} from '../../../../../acp/providers';
import { IntlTestWrapper } from '../../../../../i18n/test-utils';
import ProviderCatalogPicker from './ProviderCatalogPicker';

vi.mock('../../../../../acp/providers', () => ({
  acpGetProviderTemplate: vi.fn(),
  acpListProviderCatalogEntries: vi.fn(),
}));

const disabledReason =
  'Unsupported: authenticated custom providers require a trusted credential validation contract.';
const disabledEntry = {
  providerId: 'deepseek',
  name: 'DeepSeek',
  format: 'openai',
  apiUrl: 'https://api.deepseek.com',
  modelCount: 1,
  docUrl: '',
  envVar: 'DEEPSEEK_API_KEY',
  enabled: false,
  disabledReason,
} as unknown as ProviderTemplateCatalogEntryDto;

describe('ProviderCatalogPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpListProviderCatalogEntries).mockResolvedValue([disabledEntry]);
    vi.mocked(acpGetProviderTemplate).mockResolvedValue({} as ProviderTemplateDto);
  });

  it('shows disabled reason and never loads or selects a disabled template', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ProviderCatalogPicker onSelect={onSelect} onCancel={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    const button = await screen.findByRole('button', { name: /DeepSeek/ });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(screen.getByText(disabledReason)).toBeInTheDocument();
    await waitFor(() => expect(acpGetProviderTemplate).not.toHaveBeenCalled());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
