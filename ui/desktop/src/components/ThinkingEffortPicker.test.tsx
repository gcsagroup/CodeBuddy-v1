import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ThinkingEffortPicker, ModelThinkingMenu } from './ThinkingEffortPicker';
import {
  acpReadModelDisplaySettings,
  acpSaveThinkingEffort,
  type ModelDisplaySettings,
} from '../acp/providers';

vi.mock('../acp/providers', () => ({
  acpReadModelDisplaySettings: vi.fn(),
  acpSaveThinkingEffort: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

it('shows service default after switching to a model without a declared default', async () => {
  const read = vi.fn().mockResolvedValue({ thinking: { options: ['default', 'off', 'low', 'high'], value: 'default', toggle: false, state: 'supported' }, contextWindow: 8192, contextSource: 'service' });
  render(<ModelThinkingMenu provider="p" model="new-model" readSettings={read} />, { wrapper: IntlTestWrapper });
  expect(await screen.findByRole('button', { name: 'Thinking effort: Service default' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Thinking effort: Off' })).not.toBeInTheDocument();
  expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
});

it('labels an unsupported model as not adjustable instead of Off', () => {
  render(<ModelThinkingMenu provider="p" model="plain" triggerContent={<span>plain</span>} initialSettings={{ thinking: { options: ['off'], value: 'off', toggle: false, state: 'unsupported' }, contextWindow: 8192, contextSource: 'service' }} />, { wrapper: IntlTestWrapper });
  expect(screen.getByText('Not adjustable')).toBeVisible();
  expect(screen.queryByText('Off')).not.toBeInTheDocument();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('ThinkingEffortPicker', () => {
  it('keeps an unresolved thinking capability visible without inventing selectable levels', () => {
    render(
      <ModelThinkingMenu
        provider="p"
        model="m"
        showLabel
        showContextWindow
        initialSettings={{
          thinking: { options: [], value: null, toggle: false },
          contextWindow: 262144,
          contextSource: 'fallback',
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByRole('status')).toHaveTextContent('Thinking effort');
    expect(screen.getByRole('status')).toHaveTextContent('Not provided');
    expect(screen.getAllByText('Thinking effort')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Recheck model capabilities' })).toBeVisible();
    expect(screen.getByText('Current budget; model capacity unconfirmed')).toBeVisible();
  });
  it('renders preloaded details immediately and publishes the saved snapshot', async () => {
    const initialSettings: ModelDisplaySettings = {
      thinking: { options: ['off', 'medium'], value: 'medium', toggle: true },
      contextWindow: 262144,
      contextSource: 'service',
    };
    const changed = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelThinkingMenu
        provider="p"
        model="m"
        showLabel
        showContextWindow
        initialSettings={initialSettings}
        onEffortChanged={changed}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByText('262,144 tokens')).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
    expect(acpReadModelDisplaySettings).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thinking effort: On' }));
    await user.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() =>
      expect(changed).toHaveBeenCalledWith({
        ...initialSettings,
        thinking: { ...initialSettings.thinking, value: 'off', stalePreference: false },
      })
    );
  });
  it('activates the target model only after the effort is saved successfully', async () => {
    vi.mocked(acpReadModelDisplaySettings).mockResolvedValue({
      thinking: { options: ['low', 'high'], value: 'high', toggle: false },
      contextWindow: 262144,
      contextSource: 'service',
    });
    const saved = deferred<void>(),
      applied = vi.fn(),
      busy = vi.fn();
    vi.mocked(acpSaveThinkingEffort).mockReturnValue(saved.promise);
    const user = userEvent.setup();
    render(
      <ModelThinkingMenu provider="p" model="m" onEffortChanged={applied} onSavingChange={busy} />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(await screen.findByRole('button', { name: 'Thinking effort: High' }));
    await user.click(screen.getByRole('radio', { name: 'Low' }));
    expect(applied).not.toHaveBeenCalled();
    expect(busy).toHaveBeenLastCalledWith(true);
    saved.resolve(undefined);
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it('shows a read state immediately and displays the context from the same model snapshot', async () => {
    const ready = deferred<Awaited<ReturnType<typeof acpReadModelDisplaySettings>>>();
    vi.mocked(acpReadModelDisplaySettings).mockReturnValue(ready.promise);
    render(<ModelThinkingMenu provider="p" model="m" showLabel showContextWindow />, {
      wrapper: IntlTestWrapper,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Reading…');
    ready.resolve({
      thinking: { options: [], value: null, toggle: false },
      contextWindow: 262144,
      contextSource: 'service',
    });
    expect(await screen.findByText('262,144 tokens')).toBeVisible();
    expect(screen.getByText('No verified controls')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Recheck model capabilities' })).toBeVisible();
  });
  it('does not offer a disclosure for a single supported level or a non-reasoning model', () => {
    const view = render(
      <ThinkingEffortPicker
        settings={{ options: ['high'], value: 'high', toggle: false }}
        onChange={vi.fn()}
        showLabel
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByText('High')).toBeVisible();
    expect(screen.getByText('Thinking effort')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    view.rerender(
      <ThinkingEffortPicker
        settings={{ options: [], value: null, toggle: false }}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText('High')).not.toBeInTheDocument();
  });
  it('shows exactly the offered levels and forwards the chosen value', async () => {
    const user = userEvent.setup(),
      change = vi.fn();
    render(
      <ThinkingEffortPicker
        settings={{ options: ['low', 'high'], value: 'high', toggle: false }}
        onChange={change}
      />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
    expect(screen.getAllByRole('radio').map((item) => item.getAttribute('value'))).toEqual([
      'low',
      'high',
    ]);
    expect(screen.getByRole('radio', { name: 'High' })).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'Off' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Low' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('low');
  });
  it('uses an on/off card for a boolean-only model and saves against its provider and model', async () => {
    vi.mocked(acpReadModelDisplaySettings).mockResolvedValue({
      thinking: {
        options: ['off', 'medium'],
        value: 'medium',
        toggle: true,
      },
      contextWindow: 262144,
      contextSource: 'service',
    });
    vi.mocked(acpSaveThinkingEffort).mockResolvedValue();
    const user = userEvent.setup();
    render(<ModelThinkingMenu provider="connection-A" model="boolean-model" showLabel />, {
      wrapper: IntlTestWrapper,
    });
    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'Thinking effort: On' }));
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() =>
      expect(acpSaveThinkingEffort).toHaveBeenCalledExactlyOnceWith(
        'off',
        'connection-A',
        'boolean-model'
      )
    );
    expect(await screen.findByRole('button', { name: 'Thinking effort: Off' })).toBeVisible();
  });
  it('labels API-declared controls without claiming verified model behavior', async () => {
    render(<ThinkingEffortPicker settings={{ options: ['low', 'high'], value: 'high', toggle: false, source: 'openapi' }} onChange={vi.fn()} />, { wrapper: IntlTestWrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
    expect(screen.getByText('Options declared by the API; their effect on this model has not been verified.')).toBeVisible();
  });

  it('shows only template-validated levels and labels the validation boundary', async () => {
    render(<ThinkingEffortPicker settings={{ options: ['off', 'low', 'medium', 'xhigh'], value: 'xhigh', toggle: false, source: 'tokenize' }} onChange={vi.fn()} />, { wrapper: IntlTestWrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Thinking effort: Extra high' }));
    expect(screen.getByText('Validated with this model’s tokenizer template, without generation. Reasoning quality has not been measured.')).toBeVisible();
    expect(screen.queryByRole('radio', { name: /^High$/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /^Maximum$/ })).toBeNull();
  });

  it('keeps a failed save open without changing the confirmed selection', async () => {
    vi.mocked(acpReadModelDisplaySettings).mockResolvedValue({
      thinking: {
        options: ['low', 'high'],
        value: 'high',
        toggle: false,
      },
      contextWindow: 262144,
      contextSource: 'service',
    });
    vi.mocked(acpSaveThinkingEffort).mockRejectedValue(new Error('private configuration path'));
    const user = userEvent.setup();
    render(<ModelThinkingMenu provider="p" model="m" />, { wrapper: IntlTestWrapper });
    await user.click(await screen.findByRole('button', { name: 'Thinking effort: High' }));
    await user.click(screen.getByRole('radio', { name: 'Low' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private');
    expect(screen.getByRole('radio', { name: 'High' })).toBeChecked();
  });
});


it('ignores a late previous-model response and refreshes only on explicit recheck', async () => {
  const a = deferred<ModelDisplaySettings>();
  const b = { thinking: { options: ['off', 'medium'] as const, value: 'off', toggle: true, state: 'supported' }, contextWindow: 32768, contextSource: 'service' } as unknown as ModelDisplaySettings;
  const read = vi.fn().mockImplementation((_provider, model) => model === 'A' ? a.promise : Promise.resolve(b));
  const view = render(<ModelThinkingMenu provider="p" model="A" readSettings={read} showLabel />, { wrapper: IntlTestWrapper });
  view.rerender(<ModelThinkingMenu provider="p" model="B" readSettings={read} showLabel />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Thinking effort: Off' })).toBeVisible());
  a.resolve({ thinking: { options: ['low', 'high'], value: 'high', toggle: false }, contextWindow: 65536, contextSource: 'service' });
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thinking effort: Off' }));
  expect(screen.queryByRole('radio', { name: 'High' })).not.toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'Service default' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'On' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Recheck model capabilities' }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith('p', 'B', true));
  view.rerender(<ModelThinkingMenu provider="p" model="C" readSettings={read} showLabel />);
  await waitFor(() => expect(read).toHaveBeenLastCalledWith('p', 'C', false));
});
