import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ModelThinkingMenu } from './ThinkingEffortPicker';
import { applyThinkingDraft, readThinkingDraft, stageThinkingEffort } from '../acp/providers';
import { acpChatSessionController } from '../acp/chatSessionController';
import { acpChatSessionActions, acpChatSessionStore } from '../acp/chatSessionStore';
import { createUserMessage } from '../types/message';
import type { Session } from '../types/session';
import type { ModelDisplaySettings } from '../acp/providers';

const transport = vi.hoisted(() => ({ save: vi.fn(), prompt: vi.fn() }));
vi.mock('../acp/acpConnection', () => ({
  getAcpClient: async () => ({ goose: { providersConfigSave_unstable: transport.save } }),
  isAcpRecovering: () => false,
}));
vi.mock('../acp/prompt', async original => ({
  ...await original<typeof import('../acp/prompt')>(), acpPromptSession: transport.prompt,
}));
beforeEach(() => {
  transport.save.mockReset().mockResolvedValue({});
  transport.prompt.mockReset().mockResolvedValue({ stopReason: 'end_turn' });
});

it('keeps slider changes local during a running task and applies only the last value on the next send', async () => {
  const id = 'effort-submit';
  acpChatSessionActions.setSessionMetadata(id, {
    id, provider_name: 'draft-provider', model_config: { model_name: 'draft-model' },
  } as Session);
  let finish!: (value: unknown) => void;
  transport.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const options = { getCurrentSnapshot: () => acpChatSessionStore.getSnapshot(id), onFinish: vi.fn() };
  const running = acpChatSessionController.submitMessage(id, createUserMessage('first'), options);
  render(<ModelThinkingMenu provider="draft-provider" model="draft-model" presentation="slider" deferUntilSubmit
    initialSettings={{ thinking: { options: ['low', 'medium', 'high'], value: 'high', toggle: false }, contextWindow: 32000, contextSource: 'catalog' }} />,
    { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Thinking effort: High' }));
  for (const value of ['0', '2', '1']) {
    const slider = screen.getByRole('slider');
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value } });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    await act(async () => {});
  }
  expect(transport.save).not.toHaveBeenCalled();
  expect(readThinkingDraft('draft-provider', 'draft-model')).toBe('medium');
  await acpChatSessionController.submitMessage(id, createUserMessage('blocked while running'), options);
  expect(transport.save).not.toHaveBeenCalled();
  finish({ stopReason: 'end_turn' }); await running;
  await acpChatSessionController.submitMessage(id, createUserMessage('next'), options);
  expect(transport.save).toHaveBeenCalledExactlyOnceWith({ providerId: 'draft-provider', fields: [{ key: 'thinkingEffort:draft-model', value: 'medium' }], clearFields: [] });
  expect(transport.prompt).toHaveBeenCalledTimes(2);
  expect(transport.save.mock.invocationCallOrder[0]).toBeLessThan(transport.prompt.mock.invocationCallOrder[1]);
  expect(readThinkingDraft('draft-provider', 'draft-model')).toBeUndefined();
  acpChatSessionActions.deleteSnapshot(id);
});

it('retains a failed save and a newer draft arriving during a save, isolated by provider/model', async () => {
  stageThinkingEffort('retry-provider', 'm', 'low');
  transport.save.mockRejectedValueOnce(Error('offline'));
  await expect(applyThinkingDraft('retry-provider', 'm')).rejects.toThrow('offline');
  expect(readThinkingDraft('retry-provider', 'm')).toBe('low');
  let finish!: () => void;
  transport.save.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const saving = applyThinkingDraft('retry-provider', 'm');
  await waitFor(() => expect(transport.save).toHaveBeenCalledTimes(2));
  stageThinkingEffort('retry-provider', 'm', 'high');
  await applyThinkingDraft('another-provider', 'm');
  expect(transport.save).toHaveBeenCalledTimes(2);
  finish(); await saving;
  expect(readThinkingDraft('retry-provider', 'm')).toBe('high');
  await applyThinkingDraft('retry-provider', 'm');
  expect(readThinkingDraft('retry-provider', 'm')).toBeUndefined();
});

it('keeps every mounted composer on the saved effort even when an older settings read finishes later', async () => {
  const settings: ModelDisplaySettings = { thinking: { options: ['low', 'medium', 'high'], value: 'medium', toggle: false }, contextWindow: 32000, contextSource: 'catalog' };
  let finishRead!: (settings: ModelDisplaySettings) => void;
  const read = vi.fn(() => new Promise<ModelDisplaySettings>(resolve => { finishRead = resolve; }));
  render(<>
    <ModelThinkingMenu provider="display-provider" model="m" presentation="slider" deferUntilSubmit initialSettings={settings} />
    <ModelThinkingMenu provider="display-provider" model="m" presentation="slider" deferUntilSubmit readSettings={read} />
  </>, { wrapper: IntlTestWrapper });
  await act(async () => {
    stageThinkingEffort('display-provider', 'm', 'low');
    await applyThinkingDraft('display-provider', 'm');
    finishRead(settings);
  });
  expect(readThinkingDraft('display-provider', 'm')).toBeUndefined();
  expect(screen.getAllByRole('button', { name: 'Thinking effort: Low' })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Thinking effort: Medium' })).toBeNull();
  expect(transport.save).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});
