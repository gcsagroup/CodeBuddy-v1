import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ModelThinkingMenu, ThinkingEffortPicker } from './ThinkingEffortPicker';
import { acpSaveThinkingEffort } from '../acp/providers';
import type { ModelThinkingSettings } from '../types/providers';

vi.mock('../acp/providers', () => ({
  acpReadModelDisplaySettings: vi.fn(),
  acpSaveThinkingEffort: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
const five: ModelThinkingSettings = {
  options: ['low', 'medium', 'high', 'xhigh', 'max'],
  value: 'high',
  toggle: false,
};
const initial = (thinking: ModelThinkingSettings) => ({
  thinking,
  contextWindow: 272000,
  contextSource: 'catalog' as const,
});

it('keeps a saved effort visible when the endpoint has no verified controls', () => {
  render(
    <ModelThinkingMenu
      provider="p"
      model="m"
      presentation="slider"
      modelLabel="Custom Qwen"
      triggerContent={<span>Custom Qwen</span>}
      initialSettings={initial({ options: [], value: 'xhigh', toggle: false })}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('button', { name: 'Custom Qwen' })).toHaveTextContent('Extra high');
  expect(screen.getByText(/No verified controls/)).toBeVisible();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});
const slider = () => screen.getByRole('slider', { name: 'Thinking effort' });
it('keeps service default outside the strength scale and explains that it is not off', async () => {
  render(
    <ModelThinkingMenu
      provider="p"
      model="always-on"
      presentation="slider"
      initialSettings={initial({
        options: ['default', 'low', 'medium', 'high'],
        value: 'default',
        toggle: false,
      })}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: Service default' }));
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.getByText(/This does not turn thinking off/)).toBeVisible();
  expect(screen.getByText(/does not offer an off setting.*Low/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'None' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Low' }));
  await waitFor(() =>
    expect(acpSaveThinkingEffort).toHaveBeenCalledExactlyOnceWith('low', 'p', 'always-on')
  );
  expect(slider()).toHaveAttribute('max', '2');
  expect(slider()).toHaveAttribute('aria-valuetext', 'Low');
  fireEvent.click(screen.getByRole('button', { name: 'Use model default' }));
  await waitFor(() =>
    expect(acpSaveThinkingEffort).toHaveBeenLastCalledWith('default', 'p', 'always-on')
  );
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

it('the leftmost point sends low, not default or off, when off is unavailable', async () => {
  render(
    <ModelThinkingMenu
      provider="p"
      model="graded"
      presentation="slider"
      initialSettings={initial({
        options: ['default', 'low', 'medium', 'high'],
        value: 'high',
        toggle: false,
      })}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
  fireEvent.keyDown(slider(), { key: 'Home' });
  fireEvent.keyUp(slider(), { key: 'Home' });
  await waitFor(() =>
    expect(acpSaveThinkingEffort).toHaveBeenCalledExactlyOnceWith('low', 'p', 'graded')
  );
});

it('the leftmost point remains a real None control for off-capable models', async () => {
  render(
    <ModelThinkingMenu
      provider="p"
      model="off-capable"
      presentation="slider"
      initialSettings={initial({
        options: ['off', 'low', 'medium'],
        value: 'medium',
        toggle: false,
      })}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: Medium' }));
  fireEvent.keyDown(slider(), { key: 'Home' });
  fireEvent.keyUp(slider(), { key: 'Home' });
  await waitFor(() =>
    expect(acpSaveThinkingEffort).toHaveBeenCalledExactlyOnceWith('off', 'p', 'off-capable')
  );
  expect(slider()).toHaveAttribute('aria-valuetext', 'None');
  expect(screen.queryByText(/does not offer an off setting/)).not.toBeInTheDocument();
});

it('shows None for a model explicitly without thinking and does not invent a slider', () => {
  render(
    <ModelThinkingMenu
      provider="p"
      model="plain"
      presentation="slider"
      modelLabel="Plain model"
      triggerContent={<span>Plain model</span>}
      initialSettings={initial({
        options: ['off'],
        value: 'off',
        toggle: false,
        state: 'unsupported',
      })}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('button', { name: 'Plain model' })).toHaveTextContent('None');
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});
const release = (value: number) => {
  fireEvent.pointerDown(slider(), { pointerId: 1, buttons: 1 });
  fireEvent.change(slider(), { target: { value: String(value) } });
  fireEvent.pointerUp(slider(), { pointerId: 1 });
};

it('rotates the model and effort chevron clockwise when opening and closing', async () => {
  const user = userEvent.setup();
  render(
    <ModelThinkingMenu
      provider="p"
      model="m"
      presentation="slider"
      initialSettings={initial(five)}
    />,
    { wrapper: IntlTestWrapper }
  );
  const trigger = screen.getByRole('button', { name: 'Thinking effort: High' });
  const chevron = trigger.querySelector('.lucide-chevron-down');
  expect(chevron).toHaveStyle({ transform: 'rotate(0deg)' });
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(chevron).toHaveStyle({ transform: 'rotate(180deg)' });
  await user.keyboard('{Escape}');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(chevron).toHaveStyle({ transform: 'rotate(360deg)' });
});

it('previews continuous dragging immediately and saves one actual level on release', async () => {
  const user = userEvent.setup();
  render(
    <ModelThinkingMenu
      provider="p"
      model="m"
      presentation="slider"
      modelLabel="My model"
      initialSettings={initial(five)}
    />,
    { wrapper: IntlTestWrapper }
  );
  await user.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
  expect(slider()).toHaveAttribute('max', '4');
  fireEvent.pointerDown(slider(), { pointerId: 1, buttons: 1 });
  fireEvent.change(slider(), { target: { value: '2.3' } });
  expect(slider()).toHaveValue('2.3');
  expect(slider()).toHaveAttribute('aria-valuetext', 'High');
  fireEvent.change(slider(), { target: { value: '3.8' } });
  expect(slider()).toHaveAttribute('aria-valuetext', 'Maximum');
  expect(acpSaveThinkingEffort).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider(), { pointerId: 1 });
  await waitFor(() =>
    expect(acpSaveThinkingEffort).toHaveBeenCalledExactlyOnceWith('max', 'p', 'm')
  );
  expect(slider()).toHaveValue('4');
  expect(await screen.findByRole('button', { name: 'Thinking effort: Maximum' })).toBeVisible();
});

it('keeps dragging responsive during a save and serializes only the latest queued selection', async () => {
  let finish!: () => void;
  vi.mocked(acpSaveThinkingEffort)
    .mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    )
    .mockResolvedValue(undefined);
  render(
    <ModelThinkingMenu
      provider="p"
      model="m"
      presentation="slider"
      initialSettings={initial(five)}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
  release(0);
  await waitFor(() => expect(acpSaveThinkingEffort).toHaveBeenCalledTimes(1));
  release(1);
  release(4);
  expect(slider()).toBeEnabled();
  expect(slider()).toHaveValue('4');
  expect(acpSaveThinkingEffort).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(acpSaveThinkingEffort).toHaveBeenCalledTimes(2));
  expect(vi.mocked(acpSaveThinkingEffort).mock.calls.map((call) => call[0])).toEqual([
    'low',
    'max',
  ]);
});

it('rolls back a failed save without displaying private error details', async () => {
  vi.mocked(acpSaveThinkingEffort).mockRejectedValue(new Error('private fixture path'));
  render(
    <ModelThinkingMenu
      provider="p"
      model="m"
      presentation="slider"
      initialSettings={initial(five)}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
  release(0);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save thinking effort');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  expect(slider()).toHaveValue('2');
  expect(slider()).toHaveAttribute('aria-valuetext', 'High');
});

it.each<{ options: ModelThinkingSettings['options'] }>([
  { options: ['low', 'high', 'max'] },
  { options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
])('uses the exact available levels of a different model: $options', async ({ options }) => {
  const changed = vi.fn();
  render(
    <ThinkingEffortPicker
      presentation="slider"
      settings={{ options, value: options[0], toggle: false }}
      onChange={changed}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button'));
  expect(slider()).toHaveAttribute('max', String(options.length - 1));
  release(options.length - 1);
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(options[options.length - 1]));
});

it('cancels an unfinished drag without saving its preview', () => {
  const changed = vi.fn();
  render(<ThinkingEffortPicker presentation="slider" settings={five} onChange={changed} />, {
    wrapper: IntlTestWrapper,
  });
  fireEvent.click(screen.getByRole('button'));
  fireEvent.pointerDown(slider(), { pointerId: 1, buttons: 1 });
  fireEvent.change(slider(), { target: { value: '0.4' } });
  fireEvent.pointerCancel(slider(), { pointerId: 1 });
  expect(slider()).toHaveValue('2');
  expect(changed).not.toHaveBeenCalled();
});

it('adapts to a two-state model and keyboard controls without fabricating extra levels', async () => {
  const changed = vi.fn();
  render(
    <ThinkingEffortPicker
      presentation="slider"
      settings={{ options: ['off', 'medium'], value: 'medium', toggle: true }}
      onChange={changed}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: On' }));
  expect(slider()).toHaveAttribute('max', '1');
  fireEvent.keyDown(slider(), { key: 'Home' });
  expect(slider()).toHaveAttribute('aria-valuetext', 'None');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.keyUp(slider(), { key: 'Home' });
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith('off'));
  expect(screen.queryByText('Low')).toBeNull();
});

it.each<ModelThinkingSettings>([
  { options: [], value: null, toggle: false },
  { options: ['high'], value: 'high', toggle: false },
])('does not offer a draggable switch for zero or one level: $options', (settings) => {
  render(<ThinkingEffortPicker presentation="slider" settings={settings} onChange={vi.fn()} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('drops unsent old-model choices when switching to another model during a save', async () => {
  let finish!: () => void;
  vi.mocked(acpSaveThinkingEffort).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    })
  );
  const view = render(
    <ModelThinkingMenu
      provider="old"
      model="five"
      presentation="slider"
      initialSettings={initial(five)}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
  release(0);
  release(4);
  view.rerender(
    <ModelThinkingMenu
      provider="new"
      model="boolean"
      presentation="slider"
      initialSettings={initial({ options: ['off', 'medium'], value: 'medium', toggle: true })}
    />
  );
  await act(async () => finish());
  expect(acpSaveThinkingEffort).toHaveBeenCalledExactlyOnceWith('low', 'old', 'five');
  fireEvent.click(await screen.findByRole('button', { name: 'Thinking effort: On' }));
  expect(slider()).toHaveAttribute('max', '1');
});
