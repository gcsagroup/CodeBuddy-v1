import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommonQuerySettings, { COMMON_QUERY_CONFIG_KEY } from './CommonQuerySettings';

const mocks = vi.hoisted(() => ({ read: vi.fn(), upsert: vi.fn() }));
vi.mock('../../ConfigContext', () => ({ useConfig: () => mocks }));
function show() {
  return render(
    <IntlProvider locale="en">
      <CommonQuerySettings />
    </IntlProvider>
  );
}
describe('common query settings', () => {
  beforeEach(() => {
    mocks.read.mockReset().mockResolvedValue(null);
    mocks.upsert.mockReset().mockResolvedValue(undefined);
  });
  it('saves network, city, units and timezone together using the existing config boundary', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Default query city (optional)'), {
      target: { value: ' Guangzhou ' },
    });
    fireEvent.change(screen.getByLabelText('Country code (optional, e.g. CN)'), {
      target: { value: 'cn' },
    });
    fireEvent.change(screen.getByLabelText('Display timezone (empty uses the host timezone)'), {
      target: { value: 'Asia/Shanghai' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'imperial' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('status');
    expect(mocks.upsert).toHaveBeenCalledWith(
      COMMON_QUERY_CONFIG_KEY,
      {
        network_enabled: false,
        default_city: 'Guangzhou',
        country_code: 'CN',
        timezone: 'Asia/Shanghai',
        units: 'imperial',
      },
      false
    );
  });
  it('shows save failures without reporting success', async () => {
    mocks.upsert.mockRejectedValueOnce(new Error('offline'));
    show();
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('rejects invalid timezones without writing settings', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Display timezone (empty uses the host timezone)'), {
      target: { value: 'Not/AZone' },
    });
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('alert');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
