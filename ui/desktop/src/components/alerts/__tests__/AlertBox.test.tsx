import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, type RenderOptions, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { AlertBox } from '../AlertBox';
import { Alert, AlertType } from '../types';
import { IntlTestWrapper } from '../../../i18n/test-utils';

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions) =>
  render(ui, { wrapper: IntlTestWrapper, ...options });

const mocks = vi.hoisted(() => ({
  readPreferences: vi.fn(),
  savePreferences: vi.fn(),
  useConfig: vi.fn(),
  genericRead: vi.fn(),
  genericUpsert: vi.fn(),
  genericRemove: vi.fn(),
}));

vi.mock('../../../acp/preferences', () => ({
  readPreferences: mocks.readPreferences,
  savePreferences: mocks.savePreferences,
}));

vi.mock('../../ConfigContext', () => ({
  useConfig: mocks.useConfig,
}));

describe('AlertBox', () => {
  const mockOnCompact = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useConfig.mockReturnValue({
      read: mocks.genericRead,
      upsert: mocks.genericUpsert,
      remove: mocks.genericRemove,
      config: {},
    });
    mocks.readPreferences.mockResolvedValue({
      revision: 0,
      values: [{ key: 'autoCompactThreshold', value: 0.8 }],
    });
    mocks.savePreferences.mockResolvedValue({
      revision: 1,
      values: [{ key: 'autoCompactThreshold', value: 0.8 }],
    });
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render info alert with message', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Test info message',
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(screen.getByText('Test info message')).toBeInTheDocument();
    });

    it('should render warning alert with correct styling', () => {
      const alert: Alert = {
        type: AlertType.Warning,
        message: 'Test warning message',
      };

      const { container } = renderWithIntl(<AlertBox alert={alert} />);
      const alertElement = container.querySelector('.bg-\\[\\#cc4b03\\]');

      expect(alertElement).toBeInTheDocument();
      expect(screen.getByText('Test warning message')).toBeInTheDocument();
    });

    it('should render error alert with correct styling', () => {
      const alert: Alert = {
        type: AlertType.Error,
        message: 'Test error message',
      };

      const { container } = renderWithIntl(<AlertBox alert={alert} />);
      const alertElement = container.querySelector('.bg-\\[\\#d7040e\\]');

      expect(alertElement).toBeInTheDocument();
      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Test message',
      };

      const { container } = renderWithIntl(<AlertBox alert={alert} className="custom-class" />);
      const alertElement = container.firstChild as HTMLElement;

      expect(alertElement).toHaveClass('custom-class');
    });
  });

  describe('Progress Alert', () => {
    it('should render auto-compact threshold when progress is provided', async () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: {
          current: 50,
          total: 100,
        },
      };

      renderWithIntl(<AlertBox alert={alert} />);

      // Should show auto-compact threshold (default 80%)
      expect(await screen.findByText(/Auto compact at 80%/)).toBeInTheDocument();
    });

    it('uses the 80 percent default for an unset typed preference without generic config reads', async () => {
      mocks.readPreferences.mockResolvedValue({ revision: 4, values: [] });
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(await screen.findByText(/Auto compact at 80%/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit auto-compact threshold' })).toBeEnabled();
      expect(mocks.readPreferences).toHaveBeenCalledWith(['autoCompactThreshold']);
      expect(mocks.useConfig).not.toHaveBeenCalled();
      expect(mocks.genericRead).not.toHaveBeenCalled();
    });

    it('renders a valid non-default typed preference', async () => {
      mocks.readPreferences.mockResolvedValue({
        revision: 5,
        values: [{ key: 'autoCompactThreshold', value: 0.63 }],
      });
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(await screen.findByText(/Auto compact at 63%/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit auto-compact threshold' })).toBeEnabled();
    });

    it.each([
      ['read rejection', new Error('C:\\Users\\private\\threshold.yaml')],
      ['zero', { revision: 1, values: [{ key: 'autoCompactThreshold', value: 0 }] }],
      ['one', { revision: 1, values: [{ key: 'autoCompactThreshold', value: 1 }] }],
      ['over one', { revision: 1, values: [{ key: 'autoCompactThreshold', value: 1.1 }] }],
      ['wrong type', { revision: 1, values: [{ key: 'autoCompactThreshold', value: '0.8' }] }],
    ])('disables threshold editing after an invalid typed preference %s', async (_name, result) => {
      if (result instanceof Error) {
        mocks.readPreferences.mockRejectedValue(result);
      } else {
        mocks.readPreferences.mockResolvedValue(result);
      }
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
      };

      renderWithIntl(<AlertBox alert={alert} />);
      await waitFor(() => expect(mocks.readPreferences).toHaveBeenCalledTimes(1));
      expect(screen.getByText('Auto compact threshold unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/Auto compact at 80%/)).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Edit auto-compact threshold' })).toBeDisabled()
      );

      fireEvent.click(screen.getByRole('button', { name: 'Edit auto-compact threshold' }));
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
      expect(mocks.useConfig).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('C:\\Users\\private');
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        'C:\\Users\\private'
      );
    });

    it('updates and notifies only from the authoritative post-save snapshot', async () => {
      const onThresholdChange = vi.fn();
      mocks.savePreferences.mockResolvedValue({
        revision: 8,
        values: [{ key: 'autoCompactThreshold', value: 0.73 }],
      });
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        onThresholdChange,
      };
      const user = userEvent.setup();
      renderWithIntl(<AlertBox alert={alert} />);
      await screen.findByText(/Auto compact at 80%/);

      await user.click(screen.getByRole('button', { name: 'Edit auto-compact threshold' }));
      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '60' } });
      await user.click(screen.getByRole('button', { name: 'Save auto-compact threshold' }));

      expect(await screen.findByText(/Auto compact at 73%/)).toBeInTheDocument();
      expect(mocks.savePreferences).toHaveBeenCalledWith([
        { key: 'autoCompactThreshold', value: 0.6, isMutable: true },
      ]);
      expect(onThresholdChange).toHaveBeenCalledTimes(1);
      expect(onThresholdChange).toHaveBeenCalledWith(0.73);
      expect(mocks.genericUpsert).not.toHaveBeenCalled();
      expect(mocks.genericRemove).not.toHaveBeenCalled();
    });

    it('limits editable percentages below the Harness context ceiling', async () => {
      mocks.savePreferences.mockImplementation(async (values) => {
        if (values[0].value >= 1) throw new Error('Compaction threshold must be below one');
        return { revision: 2, values };
      });
      renderWithIntl(
        <AlertBox
          alert={{ type: AlertType.Info, message: 'Context', progress: { current: 50, total: 100 } }}
        />
      );
      const user = userEvent.setup();
      await screen.findByText(/Auto compact at 80%/);
      await user.click(screen.getByRole('button', { name: 'Edit auto-compact threshold' }));
      const input = screen.getByRole('spinbutton');
      expect(input).toHaveAttribute('max', '99');
      fireEvent.change(input, { target: { value: '100' } });
      await user.click(screen.getByRole('button', { name: 'Save auto-compact threshold' }));
      expect(mocks.savePreferences).toHaveBeenCalledWith([
        { key: 'autoCompactThreshold', value: 0.99, isMutable: true },
      ]);
      expect(await screen.findByText(/Auto compact at 99%/)).toBeInTheDocument();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('keeps the prior authority and sends no callback when typed save rejects', async () => {
      const onThresholdChange = vi.fn();
      mocks.savePreferences.mockRejectedValue(new Error('C:\\Users\\private\\preferences.yaml'));
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        onThresholdChange,
      };
      const user = userEvent.setup();
      renderWithIntl(<AlertBox alert={alert} />);
      await screen.findByText(/Auto compact at 80%/);

      await user.click(screen.getByRole('button', { name: 'Edit auto-compact threshold' }));
      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '60' } });
      await user.click(screen.getByRole('button', { name: 'Save auto-compact threshold' }));
      await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1));

      expect(input).toHaveValue(60);
      expect(onThresholdChange).not.toHaveBeenCalled();
      expect(mocks.genericUpsert).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('C:\\Users\\private');
      expect(JSON.stringify(vi.mocked(window.alert).mock.calls)).not.toContain(
        'C:\\Users\\private'
      );
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        'C:\\Users\\private'
      );
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(await screen.findByText(/Auto compact at 80%/)).toBeInTheDocument();
    });

    it.each([
      [
        'throws synchronously',
        () => {
          throw new Error('C:\\Users\\private\\callback.txt');
        },
      ],
      [
        'rejects asynchronously',
        () => Promise.reject(new Error('C:\\Users\\private\\callback.txt')),
      ],
    ])('keeps a committed save successful when the callback %s', async (_name, callback) => {
      mocks.savePreferences.mockResolvedValue({
        revision: 9,
        values: [{ key: 'autoCompactThreshold', value: 0.73 }],
      });
      const onThresholdChange = vi.fn(callback);
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        onThresholdChange,
      };
      const user = userEvent.setup();
      renderWithIntl(<AlertBox alert={alert} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Edit auto-compact threshold' })).toBeEnabled()
      );

      await user.click(screen.getByRole('button', { name: 'Edit auto-compact threshold' }));
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60' } });
      await user.click(screen.getByRole('button', { name: 'Save auto-compact threshold' }));

      expect(await screen.findByText(/Auto compact at 73%/)).toBeInTheDocument();
      await waitFor(() => expect(console.error).toHaveBeenCalled());
      expect(window.alert).not.toHaveBeenCalled();
      expect(mocks.savePreferences).toHaveBeenCalledTimes(1);
      expect(onThresholdChange).toHaveBeenCalledWith(0.73);
      expect(document.body.textContent).not.toContain('C:\\Users\\private');
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        'C:\\Users\\private'
      );
    });

    it('rejects an invalid post-save snapshot without changing the prior authority', async () => {
      const onThresholdChange = vi.fn();
      mocks.savePreferences.mockResolvedValue({ revision: 2, values: [] });
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        onThresholdChange,
      };
      const user = userEvent.setup();
      renderWithIntl(<AlertBox alert={alert} />);
      await screen.findByText(/Auto compact at 80%/);

      await user.click(screen.getByRole('button', { name: 'Edit auto-compact threshold' }));
      await user.click(screen.getByRole('button', { name: 'Save auto-compact threshold' }));
      await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1));

      expect(onThresholdChange).not.toHaveBeenCalled();
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });

    it('should not render progress dots or token counts', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: {
          current: 1500,
          total: 10000,
        },
      };

      const { container } = renderWithIntl(<AlertBox alert={alert} />);

      // Progress dots and token counts are no longer rendered
      expect(screen.queryByText('1.5k')).not.toBeInTheDocument();
      expect(screen.queryByText('10k')).not.toBeInTheDocument();
      expect(screen.queryByText('15%')).not.toBeInTheDocument();
      const progressDots = container.querySelectorAll('.h-\\[2px\\]');
      expect(progressDots.length).toBe(0);
    });
  });

  describe('Compact Button', () => {
    it('should render compact button when showCompactButton is true', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        showCompactButton: true,
        onCompact: mockOnCompact,
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(screen.getByText('Compact now')).toBeInTheDocument();
    });

    it('should render compact button with custom icon', () => {
      const CompactIcon = () => <span data-testid="compact-icon">📦</span>;

      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        showCompactButton: true,
        onCompact: mockOnCompact,
        compactIcon: <CompactIcon />,
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(screen.getByTestId('compact-icon')).toBeInTheDocument();
      expect(screen.getByText('Compact now')).toBeInTheDocument();
    });

    it('should call onCompact when compact button is clicked', async () => {
      const user = userEvent.setup();

      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        showCompactButton: true,
        onCompact: mockOnCompact,
      };

      renderWithIntl(<AlertBox alert={alert} />);

      const compactButton = screen.getByText('Compact now');
      await user.click(compactButton);

      expect(mockOnCompact).toHaveBeenCalledTimes(1);
    });

    it('should prevent event propagation when compact button is clicked', () => {
      const mockParentClick = vi.fn();

      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        showCompactButton: true,
        onCompact: mockOnCompact,
      };

      renderWithIntl(
        <div onClick={mockParentClick}>
          <AlertBox alert={alert} />
        </div>
      );

      const compactButton = screen.getByText('Compact now');
      fireEvent.click(compactButton);

      expect(mockOnCompact).toHaveBeenCalledTimes(1);
      expect(mockParentClick).not.toHaveBeenCalled();
    });

    it('should not render compact button when showCompactButton is false', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        showCompactButton: false,
        onCompact: mockOnCompact,
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(screen.queryByText('Compact now')).not.toBeInTheDocument();
    });

    it('should not render compact button when onCompact is not provided', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: { current: 50, total: 100 },
        showCompactButton: true,
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(screen.queryByText('Compact now')).not.toBeInTheDocument();
    });
  });

  describe('Combined Features', () => {
    it('should render threshold settings and compact button together', async () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: {
          current: 75,
          total: 100,
        },
        showCompactButton: true,
        onCompact: mockOnCompact,
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(await screen.findByText(/Auto compact at 80%/)).toBeInTheDocument();
      expect(screen.getByText('Compact now')).toBeInTheDocument();
    });

    it('should handle multiline messages', () => {
      const alert: Alert = {
        type: AlertType.Warning,
        message: 'Line 1\nLine 2\nLine 3',
      };

      renderWithIntl(<AlertBox alert={alert} />);

      expect(
        screen.getByText(
          (content) =>
            content.includes('Line 1') && content.includes('Line 2') && content.includes('Line 3')
        )
      ).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message', () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: '',
      };

      const { container } = renderWithIntl(<AlertBox alert={alert} />);

      const alertElement = container.querySelector('.flex.flex-col.gap-2');
      expect(alertElement).toBeInTheDocument();
    });

    it('should handle progress with zero total gracefully', async () => {
      const alert: Alert = {
        type: AlertType.Info,
        message: 'Context window',
        progress: {
          current: 10,
          total: 0,
        },
      };

      renderWithIntl(<AlertBox alert={alert} />);

      // Should still render threshold settings
      expect(await screen.findByText(/Auto compact at 80%/)).toBeInTheDocument();
    });
  });
});
