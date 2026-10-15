import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeSection } from './ModeSection';

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

vi.mock('./ModeSelectionItem', () => ({
  all_goose_modes: [{ key: 'auto' }, { key: 'approve' }],
  ModeSelectionItem: ({
    mode,
    currentMode,
    disabled,
    handleModeChange,
  }: {
    mode: { key: string };
    currentMode: string;
    disabled?: boolean;
    handleModeChange: (mode: string) => Promise<void>;
  }) => (
    <button
      aria-pressed={currentMode === mode.key}
      disabled={disabled}
      onClick={() => void handleModeChange(mode.key)}
    >
      mode-{mode.key}
    </button>
  ),
}));

vi.mock('../../../i18n', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe('ModeSection max turns preferences', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useConfig.mockReturnValue({
      config: { GOOSE_MODE: 'auto' },
      read: mocks.genericRead,
      upsert: mocks.genericUpsert,
      remove: mocks.genericRemove,
    });
    mocks.readPreferences.mockResolvedValue({
      revision: 0,
      values: [{ key: 'gooseMaxTurns', isMutable: true, value: 1000 }],
    });
    mocks.savePreferences.mockResolvedValue({
      revision: 1,
      values: [{ key: 'gooseMaxTurns', isMutable: true, value: 1000 }],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('keeps the bounded turn budget active without exposing an ordinary-user limit control', async () => {
    render(<ModeSection showLimits={false} />);

    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.readPreferences).toHaveBeenCalledWith(['gooseMaxTurns']));
  });

  it('uses typed preferences for both the default mode and maximum turns', async () => {
    mocks.readPreferences.mockResolvedValue({ revision: 4, values: [] });
    mocks.savePreferences.mockResolvedValue({
      revision: 5,
      values: [{ key: 'gooseMode', isMutable: true, value: 'approve' }],
    });
    render(<ModeSection />);

    const input = screen.getByRole('spinbutton');
    await waitFor(() => expect(input).toBeEnabled());
    await waitFor(() => expect(input).toHaveValue(1000));
    expect(mocks.readPreferences).toHaveBeenCalledWith(['gooseMode']);
    expect(mocks.readPreferences).toHaveBeenCalledWith(['gooseMaxTurns']);
    expect(mocks.genericRead).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByRole('button', { name: 'mode-approve' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'mode-approve' }));
    await waitFor(() =>
      expect(mocks.savePreferences).toHaveBeenCalledWith([
        { key: 'gooseMode', isMutable: true, value: 'approve' },
      ])
    );
    expect(mocks.genericUpsert).not.toHaveBeenCalled();
  });

  it('allows choosing a default when the real ACP snapshot returns a mutable null value', async () => {
    mocks.readPreferences.mockResolvedValue({
      revision: 0,
      values: [{ key: 'gooseMode', value: null, isMutable: true }],
    });
    mocks.savePreferences.mockResolvedValue({
      revision: 1,
      values: [{ key: 'gooseMode', value: 'approve', isMutable: true }],
    });
    render(<ModeSection showLimits={false} />);
    const manual = screen.getByRole('button', { name: 'mode-approve' });
    await waitFor(() => expect(manual).toBeEnabled());
    expect(screen.getByRole('button', { name: 'mode-auto' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(mocks.savePreferences).not.toHaveBeenCalled();
    fireEvent.click(manual);
    await waitFor(() => expect(manual).toHaveAttribute('aria-pressed', 'true'));
    expect(mocks.savePreferences).toHaveBeenCalledWith([
      { key: 'gooseMode', value: 'approve', isMutable: true },
    ]);
  });

  it.each([
    ['empty list', [], 'auto', true],
    ['valid value', [{ key: 'gooseMode', value: 'approve', isMutable: true }], 'approve', true],
    ['managed value', [{ key: 'gooseMode', value: 'approve', isMutable: false }], 'approve', false],
    ['unknown value', [{ key: 'gooseMode', value: 'future-mode', isMutable: true }], null, false],
    ['managed null', [{ key: 'gooseMode', value: null, isMutable: false }], null, false],
  ] as const)(
    'handles the %s default-mode snapshot without widening permissions',
    async (_name, values, selected, editable) => {
      mocks.readPreferences.mockResolvedValue({ revision: 0, values });
      render(<ModeSection showLimits={false} />);
      if (selected === null) {
        expect(await screen.findByRole('alert')).toHaveTextContent('Not synchronized');
        expect(screen.getByRole('button', { name: 'mode-auto' })).toHaveAttribute(
          'aria-pressed',
          'false'
        );
        expect(screen.getByRole('button', { name: 'mode-approve' })).toHaveAttribute(
          'aria-pressed',
          'false'
        );
      } else {
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'mode-' + selected })).toHaveAttribute(
            'aria-pressed',
            'true'
          )
        );
      }
      const manual = screen.getByRole('button', { name: 'mode-approve' });
      await waitFor(() =>
        editable ? expect(manual).toBeEnabled() : expect(manual).toBeDisabled()
      );
      expect(mocks.savePreferences).not.toHaveBeenCalled();
    }
  );

  it('loads the persisted mode from the typed preference authority', async () => {
    mocks.readPreferences.mockImplementation(async (keys: string[]) => ({
      revision: 3,
      values: keys.includes('gooseMode')
        ? [{ key: 'gooseMode', isMutable: true, value: 'approve' }]
        : [{ key: 'gooseMaxTurns', isMutable: true, value: 1000 }],
    }));

    render(<ModeSection />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'mode-approve' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    );
    expect(screen.getByRole('button', { name: 'mode-auto' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it.each([640, 1, 10_000])('renders the valid typed max-turn value %i', async (value) => {
    mocks.readPreferences.mockResolvedValue({
      revision: 3,
      values: [{ key: 'gooseMaxTurns', isMutable: true, value }],
    });
    render(<ModeSection />);

    const input = screen.getByRole('spinbutton');
    await waitFor(() => expect(input).toBeEnabled());
    await waitFor(() => expect(input).toHaveValue(value));
  });

  it.each([1, 10_000])(
    'submits and accepts the inclusive max-turn boundary %i through the typed path',
    async (value) => {
      mocks.savePreferences.mockResolvedValue({
        revision: 4,
        values: [{ key: 'gooseMaxTurns', isMutable: true, value }],
      });
      render(<ModeSection />);
      const input = screen.getByRole('spinbutton');
      await waitFor(() => expect(input).toBeEnabled());

      fireEvent.change(input, { target: { value: String(value) } });
      fireEvent.blur(input);

      await waitFor(() =>
        expect(mocks.savePreferences).toHaveBeenCalledWith([
          { key: 'gooseMaxTurns', isMutable: true, value },
        ])
      );
      await waitFor(() => expect(input).toHaveValue(value));
      expect(input).toBeEnabled();
      expect(mocks.genericUpsert).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['read rejection', new Error('unavailable')],
    ['zero', { revision: 1, values: [{ key: 'gooseMaxTurns', isMutable: true, value: 0 }] }],
    [
      'over maximum',
      { revision: 1, values: [{ key: 'gooseMaxTurns', isMutable: true, value: 10001 }] },
    ],
    ['fraction', { revision: 1, values: [{ key: 'gooseMaxTurns', isMutable: true, value: 1.5 }] }],
    [
      'wrong type',
      { revision: 1, values: [{ key: 'gooseMaxTurns', isMutable: true, value: '1000' }] },
    ],
  ])('fails closed after an invalid typed read: %s', async (_name, result) => {
    if (result instanceof Error) mocks.readPreferences.mockRejectedValue(result);
    else mocks.readPreferences.mockResolvedValue(result);
    render(<ModeSection />);

    await waitFor(() =>
      expect(
        mocks.readPreferences.mock.calls.filter(([keys]) => keys.includes('gooseMaxTurns'))
      ).toHaveLength(1)
    );
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.getByRole('spinbutton')).toHaveValue(null);
    expect(mocks.genericRead).not.toHaveBeenCalled();
  });

  it('disables the draft while saving and adopts only the post-save authority', async () => {
    const pending = deferred<{
      revision: number;
      values: Array<{ key: 'gooseMaxTurns'; value: number; isMutable: boolean }>;
    }>();
    mocks.savePreferences.mockReturnValue(pending.promise);
    render(<ModeSection />);
    const input = screen.getByRole('spinbutton');
    await waitFor(() => expect(input).toBeEnabled());

    fireEvent.change(input, { target: { value: '600' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(mocks.savePreferences).toHaveBeenCalledWith([
        { key: 'gooseMaxTurns', isMutable: true, value: 600 },
      ])
    );
    expect(input).toBeDisabled();
    expect(mocks.genericUpsert).not.toHaveBeenCalled();

    pending.resolve({
      revision: 7,
      values: [{ key: 'gooseMaxTurns', isMutable: true, value: 730 }],
    });
    await waitFor(() => expect(input).toHaveValue(730));
    expect(input).toBeEnabled();
  });

  it('keeps a failed draft and retries without changing generic config', async () => {
    mocks.savePreferences
      .mockRejectedValueOnce(new Error('save unavailable'))
      .mockResolvedValueOnce({
        revision: 8,
        values: [{ key: 'gooseMaxTurns', isMutable: true, value: 650 }],
      });
    render(<ModeSection />);
    const input = screen.getByRole('spinbutton');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: '600' } });

    fireEvent.blur(input);
    await waitFor(() => expect(mocks.savePreferences).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue(600);

    fireEvent.focus(input);
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.savePreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveValue(650));
    expect(mocks.genericUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { revision: 2, values: [] }],
    [
      'duplicate',
      {
        revision: 2,
        values: [
          { key: 'gooseMaxTurns', isMutable: true, value: 600 },
          { key: 'gooseMaxTurns', isMutable: true, value: 700 },
        ],
      },
    ],
    ['zero', { revision: 2, values: [{ key: 'gooseMaxTurns', isMutable: true, value: 0 }] }],
    ['fraction', { revision: 2, values: [{ key: 'gooseMaxTurns', isMutable: true, value: 1.5 }] }],
  ])('keeps the draft after an invalid post-save snapshot: %s', async (_name, snapshot) => {
    mocks.savePreferences.mockResolvedValue(snapshot);
    render(<ModeSection />);
    const input = screen.getByRole('spinbutton');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: '600' } });

    fireEvent.blur(input);
    await waitFor(() => expect(mocks.savePreferences).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input).toBeEnabled());
    await waitFor(() => expect(input).toHaveValue(600));
    expect(mocks.genericUpsert).not.toHaveBeenCalled();
  });

  it('waits for a shared pending mutation before a remounted instance loads authority', async () => {
    const pending = deferred<{
      revision: number;
      values: Array<{ key: 'gooseMaxTurns'; value: number; isMutable: boolean }>;
    }>();
    let maxTurnsReads = 0;
    mocks.readPreferences.mockImplementation(async (keys: string[]) => {
      if (keys.includes('gooseMode')) return { revision: 0, values: [] };
      maxTurnsReads += 1;
      return maxTurnsReads === 1
        ? {
            revision: 0,
            values: [{ key: 'gooseMaxTurns', isMutable: true, value: 1000 }],
          }
        : {
            revision: 1,
            values: [{ key: 'gooseMaxTurns', isMutable: true, value: 730 }],
          };
    });
    mocks.savePreferences.mockReturnValue(pending.promise);
    const first = render(<ModeSection />);
    const firstInput = screen.getByRole('spinbutton');
    await waitFor(() => expect(firstInput).toBeEnabled());
    fireEvent.change(firstInput, { target: { value: '600' } });
    fireEvent.blur(firstInput);
    await waitFor(() => expect(mocks.savePreferences).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<ModeSection />);
    await Promise.resolve();
    expect(mocks.readPreferences).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.getByRole('spinbutton')).toHaveValue(null);

    pending.resolve({
      revision: 1,
      values: [{ key: 'gooseMaxTurns', isMutable: true, value: 730 }],
    });
    await waitFor(() => expect(mocks.readPreferences).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByRole('spinbutton')).toHaveValue(730));
    expect(screen.getByRole('spinbutton')).toBeEnabled();
  });
});
