import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentSelector } from './AgentSelector';
import { getNextChatAgent, setNextChatAgent } from '../../utils/nextChatAgent';
import { AppEvents } from '../../constants/events';
import { rememberRecentAgent } from '../../utils/recentAgents';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: request }) }));
const profile = { id: 'backend', revision: 1, name: '后端助手', avatar: '🤖', providerId: '', modelId: '', prompt: '检查实际结果', skills: [], tools: [], mcpServers: [] };
beforeEach(() => {
  request.mockReset(); localStorage.removeItem('codebuddy:recent-agents'); setNextChatAgent(null);
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile] }
    : { selection: { revision: 0, profile: null, legacy: false } });
});

it('keeps all agents available in the scrollable list and searches them', async () => {
  const presets = Array.from({ length: 7 }, (_, i) => ({ key: `preset-${i}`, profile: { ...profile, id: `preset-${i}`, name: `推荐助手${i}` } }));
  request.mockResolvedValue({ profiles: [], presets });
  const manage = vi.fn();
  render(<AgentSelector sessionId={null} busy={false} openRequest={1} onManage={manage} />);
  await screen.findByRole('menuitemradio', { name: '推荐助手0' });
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(8);
  expect(screen.getByRole('menuitemradio', { name: '推荐助手6' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '推荐助手6' } });
  fireEvent.click(screen.getByRole('menuitemradio', { name: '推荐助手6' }));
  expect(JSON.parse(localStorage.getItem('codebuddy:recent-agents')!)).toEqual(['preset-6']);
  expect(getNextChatAgent()).toBe('preset-6');
  fireEvent.pointerDown(screen.getByLabelText('自定义智能体'), { button: 0, ctrlKey: false });
  await screen.findByRole('menuitemradio', { name: '推荐助手0' });
  expect(screen.getByRole('menuitemradio', { name: '推荐助手6' })).toHaveAttribute('data-state', 'checked');
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(8);
});

it('orders custom agents and presets by recency without pinning the current selection', async () => {
  const custom = { ...profile, id: 'custom-latest', name: '自定义验收' };
  const builtin = { ...profile, id: 'preset-latest', name: '默认开发助手' };
  localStorage.setItem('codebuddy:recent-agents', JSON.stringify([custom.id, builtin.id, profile.id]));
  request.mockImplementation(async (method: string) => method.endsWith('/list')
    ? { profiles: [profile, custom], presets: [{ key: 'builtin', profile: builtin }] }
    : { selection: { revision: 1, profile, legacy: false } });
  render(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  await screen.findByRole('menuitemradio', { name: custom.name });
  expect(screen.getAllByRole('menuitemradio')).toEqual([
    screen.getByRole('menuitemradio', { name: '默认助手' }),
    screen.getByRole('menuitemradio', { name: custom.name }),
    screen.getByRole('menuitemradio', { name: builtin.name }),
    screen.getByRole('menuitemradio', { name: profile.name }),
  ]);
  expect(screen.getByRole('menuitemradio', { name: profile.name })).toHaveAttribute('data-state', 'checked');
});

it('refreshes a mounted menu when another agent entry point records usage', async () => {
  const builtin = { ...profile, id: 'builtin', name: '默认开发助手' };
  localStorage.setItem('codebuddy:recent-agents', JSON.stringify([builtin.id]));
  request.mockResolvedValue({ profiles: [profile], presets: [{ key: 'builtin', profile: builtin }] });
  render(<AgentSelector sessionId={null} busy={false} openRequest={1} />);
  await screen.findByRole('menuitemradio', { name: profile.name });
  expect(screen.getAllByRole('menuitemradio')).toEqual([
    screen.getByRole('menuitemradio', { name: '默认助手' }),
    screen.getByRole('menuitemradio', { name: builtin.name }),
    screen.getByRole('menuitemradio', { name: profile.name }),
  ]);
  act(() => rememberRecentAgent(profile.id));
  expect(screen.getAllByRole('menuitemradio')).toEqual([
    screen.getByRole('menuitemradio', { name: '默认助手' }),
    screen.getByRole('menuitemradio', { name: profile.name }),
    screen.getByRole('menuitemradio', { name: builtin.name }),
  ]);
});

it('distinguishes same-name custom agents and templates while preserving their identities and recency', async () => {
  const custom = { ...profile, id: 'custom-backend' };
  const builtin = { ...profile, id: 'preset-backend' };
  localStorage.setItem('codebuddy:recent-agents', JSON.stringify([custom.id, builtin.id]));
  request.mockImplementation(async (method: string, input) => method.endsWith('/list')
    ? { profiles: [custom], presets: [{ key: 'backend', profile: builtin }] }
    : { selection: { revision: input.id === builtin.id ? 2 : 1, profile: input.id === builtin.id ? builtin : custom, legacy: false } });
  render(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  const customItem = await screen.findByRole('menuitemradio', { name: `${profile.name}，自定义` });
  const builtinItem = screen.getByRole('menuitemradio', { name: `${profile.name}，内置` });
  expect(screen.getAllByRole('menuitemradio').slice(1)).toEqual([customItem, builtinItem]);
  expect(within(customItem).getByText(profile.name)).toBeInTheDocument();
  expect(within(customItem).getByText('自定义')).toHaveAttribute('title', '你保存的独立智能体，配置与内置模板分开');
  expect(within(builtinItem).getByText('内置')).toHaveAttribute('title', 'CodeBuddy 提供的默认模板');
  expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', profile.name);
  expect(within(screen.getByLabelText('自定义智能体')).queryByText('自定义')).not.toBeInTheDocument();
  expect(screen.queryByText(`${profile.name}（我的）`)).not.toBeInTheDocument();
  fireEvent.click(builtinItem);
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('aria-description', '内置：CodeBuddy 提供的默认模板'));
  expect(within(screen.getByLabelText('自定义智能体')).queryByText('内置')).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledWith('_codebuddy/agents/select', { sessionId: 'conversation-a', id: builtin.id, expectedRevision: 1 });
  expect(JSON.parse(localStorage.getItem('codebuddy:recent-agents')!)).toEqual([builtin.id, custom.id]);
});

it('adds and removes origin hints after renames without changing the adopted role revision', async () => {
  const custom = { ...profile, id: 'custom-backend' };
  const builtin = { ...profile, id: 'preset-backend' };
  let catalogProfile = custom;
  request.mockImplementation(async (method: string) => method.endsWith('/list')
    ? { profiles: [catalogProfile], presets: [{ key: 'backend', profile: builtin }] }
    : { selection: { revision: 1, profile: custom, legacy: false } });
  render(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  await screen.findByRole('menuitemradio', { name: `${profile.name}，自定义` });

  catalogProfile = { ...custom, name: '我的后端验收', revision: 2 };
  fireEvent(window, new Event(AppEvents.AGENT_PROFILES_CHANGED));
  const renamed = await screen.findByRole('menuitemradio', { name: catalogProfile.name });
  expect(renamed).toHaveAttribute('title', catalogProfile.name);
  expect(screen.getByRole('menuitemradio', { name: builtin.name })).toHaveAttribute('title', builtin.name);
  expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', catalogProfile.name);
  expect(within(screen.getByLabelText('自定义智能体')).queryByText('自定义')).not.toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: '应用更新' })).toBeInTheDocument();

  catalogProfile = { ...custom, revision: 3 };
  fireEvent(window, new Event(AppEvents.AGENT_PROFILES_CHANGED));
  await screen.findByRole('menuitemradio', { name: `${profile.name}，自定义` });
  expect(within(screen.getByRole('menuitemradio', { name: `${profile.name}，内置` })).getByText('内置')).toBeInTheDocument();
  expect(within(screen.getByLabelText('自定义智能体')).queryByText('自定义')).not.toBeInTheDocument();
  expect(request.mock.calls.some(([method]) => method.endsWith('/select'))).toBe(false);
});

it('selects and cancels the main role in the same conversation using Host revisions', async () => {
  render(<AgentSelector sessionId="conversation-a" busy openRequest={1} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument();
  await screen.findByRole('menuitemradio', { name: '后端助手' });
  request.mockResolvedValueOnce({ selection: { revision: 1, profile, legacy: false }, pending: true });
  fireEvent.click(screen.getByRole('menuitemradio', { name: '后端助手' }));
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveTextContent('后端助手'));
  expect(request).toHaveBeenCalledWith('_codebuddy/agents/select', { sessionId: 'conversation-a', id: 'backend', expectedRevision: 0 });
  expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手');
  expect(screen.queryByText('下轮生效')).not.toBeInTheDocument();
  request.mockResolvedValueOnce({ selection: { revision: 2, profile: null, legacy: false }, pending: true });
  fireEvent.pointerDown(screen.getByLabelText('自定义智能体'), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '默认助手' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument());
  expect(request).toHaveBeenCalledWith('_codebuddy/agents/select', { sessionId: 'conversation-a', id: null, expectedRevision: 1 });
});

it('keeps the last confirmed selection when saving fails', async () => {
  render(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await screen.findByRole('menuitemradio', { name: '后端助手' });
  request.mockRejectedValueOnce(new Error('Selection changed elsewhere'));
  fireEvent.click(screen.getByRole('menuitemradio', { name: '后端助手' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Selection changed elsewhere');
  expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument();
});

it('keeps new-task selection as a draft instead of creating another conversation', async () => {
  render(<AgentSelector sessionId={null} busy={false} openRequest={1} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '后端助手' }));
  expect(getNextChatAgent()).toBe('backend');
  expect(request.mock.calls.every(([method]) => method === '_codebuddy/agents/list')).toBe(true);
});

it('offers built-ins and creation before any custom agent exists', async () => {
  const builtin = { ...profile, id: 'builtin-backend' };
  request.mockResolvedValue({ profiles: [], presets: [{ key: 'backend', profile: builtin }] });
  const manage = vi.fn();
  render(<AgentSelector sessionId={null} busy={false} openRequest={1} onManage={manage} />);
  expect(await screen.findByRole('menuitem', { name: '管理自定义智能体' })).toBeVisible();
  fireEvent.click(screen.getByRole('menuitemradio', { name: '后端助手' }));
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveTextContent('后端助手'));
  expect(getNextChatAgent()).toBe('builtin-backend');
  expect(request.mock.calls.every(([method]) => method.endsWith('/list'))).toBe(true);
});

it('applies an edited template only after the user explicitly requests its update', async () => {
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [{ ...profile, revision: 2 }] }
    : { selection: { revision: 4, profile, legacy: false } });
  render(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  const update = await screen.findByRole('menuitem', { name: '应用更新' });
  expect(request.mock.calls.some(([method]) => method.endsWith('/select'))).toBe(false);
  request.mockResolvedValueOnce({ selection: { revision: 5, profile: { ...profile, revision: 2 }, legacy: false }, pending: false });
  fireEvent.click(update);
  await waitFor(() => expect(screen.queryByRole('menuitem', { name: '应用更新' })).not.toBeInTheDocument());
  expect(request).toHaveBeenCalledWith('_codebuddy/agents/select', { sessionId: 'conversation-a', id: 'backend', expectedRevision: 4 });
});

it('keeps a pending role visible after the previous turn ends until the Host confirms adoption', async () => {
  let adopted = false;
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile] }
    : { selection: { revision: 2, profile, legacy: false }, effective: adopted ? profile : null, pending: !adopted });
  const view = render(<AgentSelector sessionId="conversation-a" busy />);
  expect(await screen.findByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手');
  view.rerender(<AgentSelector sessionId="conversation-a" busy={false} />);
  await waitFor(() => expect(request.mock.calls.filter(([method]) => method.endsWith('/current'))).toHaveLength(2));
  expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手');
  adopted = true;
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手'));
});

it('refreshes on native admission while busy stays true, without accepting another conversation receipt', async () => {
  let adopted = false;
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile] }
    : { selection: { revision: 2, profile, legacy: false }, effective: adopted ? profile : null, pending: !adopted });
  render(<AgentSelector sessionId="conversation-a" busy />);
  expect(await screen.findByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手');
  const count = request.mock.calls.length;
  adopted = true;
  fireEvent(window, new CustomEvent(AppEvents.AGENT_INPUT_ADMITTED, { detail: { sessionId: 'conversation-b' } }));
  expect(request).toHaveBeenCalledTimes(count);
  expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手');
  fireEvent(window, new CustomEvent(AppEvents.AGENT_INPUT_ADMITTED, { detail: { sessionId: 'conversation-a' } }));
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', '后端助手'));
  expect(request).toHaveBeenCalledWith('_codebuddy/agents/current', { sessionId: 'conversation-a' });
});

it('requires explicit conversion before switching a legacy workspace role', async () => {
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile] }
    : { selection: { revision: 0, profile, legacy: true }, effective: profile, pending: false });
  render(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  expect(await screen.findByText('旧工作区角色')).toBeVisible();
  expect(screen.getByRole('menuitemradio', { name: '默认助手' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('menuitemradio', { name: '后端助手' })).toHaveAttribute('aria-disabled', 'true');
  request.mockResolvedValueOnce({ selection: { revision: 1, profile, legacy: false }, effective: profile, pending: false });
  fireEvent.click(screen.getByRole('menuitem', { name: '转换为可切换智能体' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('_codebuddy/agents/convert', { sessionId: 'conversation-a', expectedRevision: 0 }));
  expect(request.mock.calls.some(([method]) => method.endsWith('/select'))).toBe(false);
  expect(screen.getByLabelText('自定义智能体')).toHaveTextContent('后端助手');
});

it('retains the selection receipt when the running turn finishes during the save', async () => {
  const next = { ...profile, id: 'next', name: 'AI 助手' };
  let selected = profile;
  let finish!: () => void;
  request.mockImplementation(async (method: string) => {
    if (method.endsWith('/list')) return { profiles: [profile, next] };
    if (method.endsWith('/select')) {
      await new Promise<void>(resolve => { finish = resolve; });
      selected = next;
    }
    return { selection: { revision: selected === next ? 2 : 1, profile: selected, legacy: false }, effective: profile, pending: selected === next };
  });
  const view = render(<AgentSelector sessionId="conversation-a" busy openRequest={1} />);
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'AI 助手' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<AgentSelector sessionId="conversation-a" busy={false} openRequest={1} />);
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveTextContent('AI 助手'));
  expect(screen.getByLabelText('自定义智能体')).toHaveAttribute('title', 'AI 助手');
});

it('does not apply a delayed save receipt to another conversation', async () => {
  let finish!: () => void;
  request.mockImplementation(async (method: string, input) => {
    if (method.endsWith('/list')) return { profiles: [profile] };
    if (method.endsWith('/select')) {
      await new Promise<void>(resolve => { finish = resolve; });
      return { selection: { revision: 1, profile, legacy: false }, pending: true };
    }
    return { selection: { revision: 0, profile: null, legacy: false }, pending: false, session: input.sessionId };
  });
  const view = render(<AgentSelector sessionId="conversation-a" busy openRequest={1} />);
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '后端助手' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<AgentSelector sessionId="conversation-b" busy={false} openRequest={1} />);
  await waitFor(() => expect(request).toHaveBeenCalledWith('_codebuddy/agents/current', { sessionId: 'conversation-b' }));
  await act(async () => { finish(); });
  expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('keeps a deleted draft visible and lets the user clear it before sending', async () => {
  setNextChatAgent('backend');
  const view = render(<AgentSelector sessionId={null} busy={false} />);
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveTextContent('后端助手'));
  request.mockResolvedValue({ profiles: [] });
  fireEvent(window, new Event(AppEvents.AGENT_PROFILES_CHANGED));
  await waitFor(() => expect(screen.getByLabelText('自定义智能体')).toHaveTextContent('智能体不可用'));
  expect(getNextChatAgent()).toBe('backend');
  view.rerender(<AgentSelector sessionId={null} busy={false} openRequest={1} />);
  expect(await screen.findByRole('status')).toHaveTextContent('所选智能体已删除');
  fireEvent.click(screen.getByRole('menuitemradio', { name: '默认助手' }));
  expect(getNextChatAgent()).toBeNull();
  expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument();
});

it('never shows the previous conversation role when loading the new conversation fails', async () => {
  request.mockImplementation(async (method: string, input) => {
    if (method.endsWith('/list')) return { profiles: [profile] };
    if (input.sessionId === 'conversation-b') throw Error('Conversation B unavailable');
    return { selection: { revision: 5, profile, legacy: false }, effective: profile, pending: false };
  });
  const view = render(<AgentSelector sessionId="conversation-a" busy={false} />);
  expect(await screen.findByLabelText('自定义智能体')).toHaveTextContent('后端助手');
  view.rerender(<AgentSelector sessionId="conversation-b" busy={false} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Conversation B unavailable');
  expect(screen.queryByRole('button', { name: '自定义智能体' })).not.toBeInTheDocument();
  view.rerender(<AgentSelector sessionId="conversation-b" busy={false} openRequest={1} />);
  expect(screen.getByRole('menuitemradio', { name: '后端助手' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('menuitemradio', { name: '后端助手' }));
  expect(request.mock.calls.some(([method]) => method.endsWith('/select'))).toBe(false);
});
