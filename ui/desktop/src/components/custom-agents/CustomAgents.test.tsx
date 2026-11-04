import { AppEvents } from '../../constants/events';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CustomAgents } from './CustomAgents';
import { getNextChatAgent, setNextChatAgent } from '../../utils/nextChatAgent';
const { request, navigate, route } = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn(), route: { pathname: '/codepro/custom-agents', search: '', state: null as unknown } }));
vi.mock('../../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: request }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate, useLocation: () => route }));
const profile = { id: 'saved', revision: 1, name: '写作搭档', avatar: '📚', prompt: '简明、严谨。', skills: ['writing'], tools: ['read'], mcpServers: ['research'] };
const catalog = { skills: [{ name: 'writing', roleOnly: true }], tools: [{ name: 'read' }, { name: 'write' }], mcpServers: [{ name: 'research' }] };
const preset = { key: 'frontend', description: '实现页面与组件。', tags: ['组件开发', '交互实现'], profile: {
  id: 'builtin-frontend', revision: 1, name: '前端开发工程师', avatar: '🦊', prompt: '按项目规范实现界面。',
  capabilities: 'inherit', skills: ['codebuddy-frontend-design'], tools: [], mcpServers: [],
} };
beforeEach(() => {
  navigate.mockReset(); request.mockReset();
  route.pathname = '/codepro/custom-agents'; route.search = ''; route.state = null;
  setNextChatAgent(null);
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [], avatars: ['🤖', '📚'] } : method.endsWith('/catalog') ? catalog : {});
});
it('saves persona, avatar and capability lists without binding a model', async () => {
  render(<CustomAgents />);
  await waitFor(() => expect(screen.getByRole('button', { name: '新建智能体' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '新建智能体' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '写作搭档' } });
  expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('人设提示词'), { target: { value: '简明、严谨。' } });
  expect(screen.queryByLabelText('能力配置')).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: /可用工具/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '头像 📚' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'writing' }));
  const changed = vi.fn();
  window.addEventListener(AppEvents.AGENT_PROFILES_CHANGED, changed, { once: true });
  request.mockResolvedValueOnce({ profile });
  fireEvent.click(screen.getByRole('button', { name: '仅保存' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('_codebuddy/agents/save', { profile: {
    name: '写作搭档', avatar: '📚', prompt: '简明、严谨。', skills: ['writing'], tools: [], mcpServers: [], capabilities: 'inherit',
  } }));
  expect(await screen.findByRole('heading', { name: '写作搭档' })).toBeVisible();
  expect(changed).toHaveBeenCalledOnce();
});
it('selects a role for a new task without creating a workspace or a conversation', async () => {
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile], avatars: ['📚'] } : method.endsWith('/catalog') ? catalog : { sessionId: 'new-session' });
  render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '立即使用 写作搭档' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/codepro'));
  expect(navigate).toHaveBeenCalledWith('/codepro');
  expect(getNextChatAgent()).toBe('saved');
  expect(request).not.toHaveBeenCalledWith('_codebuddy/agents/create-workspace', expect.anything());
});
it('does not offer a model binding in the property form and preserves drafts on failure', async () => {
  render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '新建智能体' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '后端助手' } });
  fireEvent.change(screen.getByLabelText('人设提示词'), { target: { value: '只依据实际执行结果报告。' } });
  expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
  request.mockRejectedValueOnce(new Error('Save unavailable'));
  fireEvent.click(screen.getByRole('button', { name: '保存并应用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
  expect(screen.getByLabelText('名称')).toHaveValue('后端助手');
  expect(navigate).not.toHaveBeenCalled();
});
it('confirms deletion without deleting the existing conversation configuration', async () => {
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile], avatars: ['📚'] } : method.endsWith('/catalog') ? catalog : Promise.reject(new Error('Model unavailable')));
  render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '删除 写作搭档' }));
  expect(request).not.toHaveBeenCalledWith('_codebuddy/agents/delete', expect.anything());
  request.mockResolvedValueOnce({});
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: '写作搭档' })).not.toBeInTheDocument());
});
it('uses a built-in agent for a new conversation without saving copies or starting a conversation', async () => {
  request.mockImplementation(async (method: string, input) => method.endsWith('/list') ? { profiles: [profile], avatars: ['🦊'] }
    : method.endsWith('/catalog') ? { ...catalog, presets: [preset], skills: [{ name: 'codebuddy-frontend-design', title: '界面设计' }] }
      : { profile: { ...input.profile, id: 'added-template', revision: 1 } });
  render(<CustomAgents />);
  expect(await screen.findByRole('button', { name: '立即使用 前端开发工程师' })).toBeVisible();
  expect(request.mock.calls.some(([method]) => method.endsWith('/save'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '立即使用 前端开发工程师' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/codepro'));
  expect(request.mock.calls.some(([method]) => method.endsWith('/save'))).toBe(false);
  expect(screen.getByRole('heading', { name: '写作搭档' })).toBeVisible();
  expect(getNextChatAgent()).toBe('builtin-frontend');
  expect(request.mock.calls.every(([method]) => ['_codebuddy/agents/list', '_codebuddy/agents/catalog'].includes(method))).toBe(true);
});
it('opens a template in the existing editor and preserves the draft when adding fails', async () => {
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [], avatars: ['🦊'] }
    : method.endsWith('/catalog') ? { ...catalog, presets: [preset] } : Promise.reject(new Error('保存失败')));
  render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '自定义 前端开发工程师' }));
  expect(screen.getByLabelText('名称')).toHaveValue('前端开发工程师');
  expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的前端助手' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并应用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  expect(screen.getByLabelText('名称')).toHaveValue('我的前端助手');
  expect(preset.profile.name).toBe('前端开发工程师');
  expect(navigate).not.toHaveBeenCalled();
});

it('applies directly to its source chat and returns there without creating a copy', async () => {
  route.search = '?sessionId=source-chat';
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [], avatars: ['🦊'] }
    : method.endsWith('/catalog') ? { ...catalog, presets: [preset] }
      : { selection: { revision: 3, profile: null, legacy: false } });
  render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '应用到当前对话 前端开发工程师' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=source-chat'));
  expect(request).toHaveBeenCalledWith('_codebuddy/agents/select', { sessionId: 'source-chat', id: 'builtin-frontend', expectedRevision: 3 });
  expect(request.mock.calls.some(([method]) => method.endsWith('/save') || method === 'session/new')).toBe(false);
  expect(getNextChatAgent()).toBeNull();
});

it('retains the saved identity when applying fails, then retries the same profile without duplicating it', async () => {
  route.search = '?sessionId=source-chat';
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [], avatars: ['📚'] }
    : method.endsWith('/catalog') ? catalog
      : method.endsWith('/current') ? { selection: { revision: 3, profile: null, legacy: false } }
        : method.endsWith('/save') ? { profile }
          : Promise.reject(Error('Source chat changed')));
  render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '新建智能体' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '写作搭档' } });
  fireEvent.change(screen.getByLabelText('人设提示词'), { target: { value: '简明、严谨。' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并应用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Source chat changed');
  expect(screen.getByRole('status')).toHaveTextContent('已保存，尚未应用');
  expect(screen.getByLabelText('名称')).toHaveValue('写作搭档');
  expect(navigate).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ profile: { ...profile, revision: 2 } }).mockResolvedValueOnce({});
  fireEvent.click(screen.getByRole('button', { name: '保存并应用' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=source-chat'));
  const saves = request.mock.calls.filter(([method]) => method.endsWith('/save'));
  expect(saves).toHaveLength(2);
  expect(saves[1][1].profile.id).toBe(profile.id);
});

it('does not redirect to an old target after leaving the manager while apply is pending', async () => {
  route.search = '?sessionId=source-chat';
  let finish!: () => void;
  request.mockImplementation(async (method: string) => method.endsWith('/list') ? { profiles: [profile], avatars: ['📚'] }
    : method.endsWith('/catalog') ? catalog
      : method.endsWith('/current') ? { selection: { revision: 3, profile: null, legacy: false } }
        : new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<CustomAgents />);
  fireEvent.click(await screen.findByRole('button', { name: '应用到当前对话 写作搭档' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  finish();
  await Promise.resolve(); await Promise.resolve();
  expect(navigate).not.toHaveBeenCalled();
});
