import { AppEvents } from '../../constants/events';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Plus, ArrowRight, Check, Loader2, Trash2 } from 'lucide-react';
import { getAcpControlClient } from '../../acp/acpConnection';

import { AgentAvatar, readAvatar } from './AgentAvatar';

interface Profile {
  id?: string; revision?: number; name: string; avatar: string; providerId: string; modelId: string;
  prompt: string; skills: string[]; tools: string[]; mcpServers: string[];
}
interface Choice { name: string; description?: string }
interface Catalog {
  models: { providerId: string; modelId: string; label: string }[];
  skills: Choice[]; tools: Choice[]; mcpServers: Choice[];
}
const blank = (): Profile => ({ name: '', avatar: 'app-logo', providerId: '', modelId: '', prompt: '', skills: [], tools: [], mcpServers: [] });
async function request<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const client = await getAcpControlClient();
  return await client.extMethod(`_codebuddy/agents/${action}`, data) as unknown as T;
}
const fieldClass = 'w-full rounded-lg border border-border-primary bg-background-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-text-secondary';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-border-primary px-4 py-2 text-sm hover:bg-background-secondary disabled:opacity-50';

function Choices({ title, choices, selected, onChange }: { title: string; choices: Choice[]; selected: string[]; onChange: (values: string[]) => void }) {
  const entries = [...choices, ...selected.filter(name => !choices.some(c => c.name === name)).map(name => ({ name, description: '当前不可用；保留配置，不会自动替换' }))];
  return <fieldset className="rounded-xl border border-border-primary p-4">
    <legend className="px-1 text-sm font-medium">{title} · {selected.length}</legend>
    <div className="mb-3 flex gap-4 text-xs"><button type="button" onClick={() => onChange(choices.map(c => c.name))}>全选</button><button type="button" onClick={() => onChange([])}>清空</button></div>
    <div className="max-h-56 space-y-2 overflow-y-auto">
      {!entries.length && <p className="text-sm text-text-secondary">暂无可用项，请先在工具箱中配置。</p>}
      {entries.map(c => <label key={c.name} className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-background-secondary">
        <input type="checkbox" className="mt-1 shrink-0" checked={selected.includes(c.name)} onChange={e => onChange(e.target.checked ? [...selected, c.name] : selected.filter(n => n !== c.name))} />
        <span className="min-w-0"><span className="block break-all text-sm">{c.name}</span><span className="line-clamp-2 block text-xs text-text-secondary" title={c.description}>{c.description}</span></span>
      </label>)}
    </div>
  </fieldset>;
}

export function CustomAgents() {
  const navigate = useNavigate();
  const avatarInput = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [avatars, setAvatars] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [draft, setDraft] = useState<Profile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteId, setDeleteId] = useState<string>();
  async function load() {
    setError(''); setBusy(true);
    try {
      const [list, available] = await Promise.all([request<{ profiles: Profile[]; avatars: string[] }>('list'), request<Catalog>('catalog')]);
      setProfiles(list.profiles); setAvatars(['app-logo', ...list.avatars.filter(avatar => avatar !== 'app-logo')]); setCatalog(available);
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败，请重试'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }
  function update<K extends keyof Profile>(key: K, value: Profile[K]) { setDraft(d => d ? { ...d, [key]: value } : d); }
  return <main className="h-full overflow-y-auto bg-background-primary text-text-primary">
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 md:px-10">
      <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-2xl font-semibold"><Bot size={27} />自定义智能体</h1><p className="mt-2 max-w-2xl text-sm text-text-secondary">为每个工作区选择专属角色、模型和能力，让不同任务各有自己的助手。</p></div>
        {!draft && <button className={buttonClass} disabled={!catalog || busy} onClick={() => { setDraft(blank()); setNotice(''); setError(''); }}><Plus size={16} />新建智能体</button>}
      </header>
      {error && <div role="alert" className="rounded-xl border border-red-400/40 p-4 text-sm">{error} <button className="ml-3 underline" onClick={() => void load()} disabled={busy}>重新加载</button></div>}
      {notice && <p role="status" className="flex items-center gap-2 text-sm"><Check size={16} />{notice}</p>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" />正在处理…</p>}
      {draft && catalog ? <form onSubmit={e => { e.preventDefault(); void run(async () => {
        const { profile } = await request<{ profile: Profile }>('save', { profile: draft });
        setProfiles(items => [...items.filter(p => p.id !== profile.id), profile]); window.dispatchEvent(new Event(AppEvents.AGENT_PROFILES_CHANGED)); setDraft(undefined); setNotice('智能体已保存，可以创建专属工作区。');
      }); }} className="space-y-6 rounded-2xl border border-border-primary p-5 md:p-7">
        <fieldset disabled={busy} className="space-y-6">
          <div className="flex items-center justify-between"><h2 className="text-lg font-medium">{draft.id ? '编辑智能体' : '创建智能体'}</h2><button type="button" className={buttonClass} onClick={() => setDraft(undefined)}>取消</button></div>
          <div><p className="mb-2 text-sm font-medium">头像</p><div className="flex flex-wrap gap-2" role="group" aria-label="头像">
            {[...avatars, ...(draft.avatar.startsWith('data:') ? [draft.avatar] : [])].map(avatar => <button key={avatar} type="button" aria-label={avatar === 'app-logo' ? '头像 应用 Logo' : avatar.startsWith('data:') ? '头像 自定义图片' : '头像 ' + avatar} aria-pressed={draft.avatar === avatar} onClick={() => update('avatar', avatar)} className={'flex size-14 items-center justify-center rounded-xl border text-2xl ' + (draft.avatar === avatar ? 'border-text-primary bg-background-secondary' : 'border-border-primary')}><AgentAvatar avatar={avatar} /></button>)}
            <button type="button" aria-label="上传头像" className="flex size-14 items-center justify-center rounded-xl border-2 border-dashed border-border-primary text-text-secondary hover:bg-background-secondary" onClick={() => avatarInput.current?.click()}><Plus size={24} /></button>
            <input ref={avatarInput} type="file" aria-label="头像图片文件" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { update('avatar', await readAvatar(file)); }); }} />
          </div><p className="mt-2 text-xs text-text-secondary">支持 PNG、JPEG、WebP，最大 5 MB；自动居中裁剪为方形。</p></div>
          <div className="grid gap-5 md:grid-cols-2">
            <label className="space-y-2 text-sm">名称<input required maxLength={80} className={fieldClass} value={draft.name} onChange={e => update('name', e.target.value)} placeholder="例如：写作搭档" /></label>
            <label className="space-y-2 text-sm">模型<select aria-label="模型" required className={fieldClass} value={draft.providerId ? JSON.stringify([draft.providerId, draft.modelId]) : ''} onChange={e => { const [providerId, modelId] = JSON.parse(e.target.value); setDraft(d => d ? { ...d, providerId, modelId } : d); }}><option value="" disabled>请选择模型</option>{catalog.models.map(m => <option key={JSON.stringify([m.providerId, m.modelId])} value={JSON.stringify([m.providerId, m.modelId])}>{m.label}</option>)}</select>{!catalog.models.length && <span className="block text-xs text-text-secondary">请先在设置中添加模型。</span>}</label>
          </div>
          <label className="block space-y-2 text-sm">人设提示词<textarea required maxLength={32000} rows={6} className={fieldClass} value={draft.prompt} onChange={e => update('prompt', e.target.value)} placeholder="描述角色身份、沟通风格、擅长的任务，以及需要遵守的规则。" /></label>
          <div className="rounded-lg bg-background-secondary p-3 text-sm text-text-secondary">语音 · 暂未开放</div>
          <p className="text-sm text-text-secondary">只开放勾选的能力。全局关闭的服务仍不可用；文件与命令工具仍遵循原有权限。Skill 选择控制技能加载，不是文件访问隔离。</p>
          <div className="grid gap-4 lg:grid-cols-3"><Choices title="可用 Skill" choices={catalog.skills} selected={draft.skills} onChange={v => update('skills', v)} /><Choices title="可用工具" choices={catalog.tools} selected={draft.tools} onChange={v => update('tools', v)} /><Choices title="MCP 服务" choices={catalog.mcpServers} selected={draft.mcpServers} onChange={v => update('mcpServers', v)} /></div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border-primary pt-5"><p className="text-xs text-text-secondary">修改仅用于之后创建的工作区，已有工作区保留原角色设置。</p><button type="submit" className={buttonClass}><Check size={16} />保存智能体</button></div>
        </fieldset>
      </form> : <>
        {!busy && catalog && !profiles.length && <div className="rounded-2xl border border-dashed border-border-primary px-6 py-16 text-center"><Bot className="mx-auto mb-4 text-text-secondary" size={40} /><h2 className="text-lg font-medium">创建你的第一个智能体</h2><p className="mt-2 text-sm text-text-secondary">写作、研究、设计或开发，为不同工作准备专属搭档。</p></div>}
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{profiles.map(profile => <article key={profile.id} className="flex flex-col gap-4 rounded-2xl border border-border-primary p-5">
          <div className="flex items-center gap-3"><span className="rounded-xl bg-background-secondary p-3 text-3xl"><AgentAvatar avatar={profile.avatar} /></span><div className="min-w-0"><h2 className="break-words text-lg font-medium">{profile.name}</h2><p className="truncate text-xs text-text-secondary" title={profile.modelId}>{profile.modelId}</p></div></div>
          <p className="line-clamp-3 min-h-16 whitespace-pre-wrap text-sm text-text-secondary">{profile.prompt}</p><p className="text-xs text-text-secondary">{profile.skills.length} 个 Skill · {profile.tools.length} 个工具 · {profile.mcpServers.length} 个 MCP 服务</p>
          <button disabled={busy} className={buttonClass} onClick={() => void run(async () => { const result = await request<{ sessionId: string }>('create-workspace', { id: profile.id }); navigate(`/codepro/pair?resumeSessionId=${encodeURIComponent(result.sessionId)}`); })}>创建工作区<ArrowRight size={16} /></button>
          <div className="flex items-center justify-between text-sm"><button disabled={busy} onClick={() => { setDraft(structuredClone(profile)); setError(''); }}>编辑</button><button aria-label={`删除 ${profile.name}`} disabled={busy} onClick={() => setDeleteId(profile.id)}><Trash2 size={15} /></button></div>
          {deleteId === profile.id && <div className="space-y-3 border-t border-border-primary pt-3 text-sm"><p>删除此智能体？已有工作区及角色配置会保留。</p><div className="flex gap-4"><button disabled={busy} onClick={() => void run(async () => { await request('delete', { id: profile.id }); window.dispatchEvent(new Event(AppEvents.AGENT_PROFILES_CHANGED)); setProfiles(items => items.filter(p => p.id !== profile.id)); setDeleteId(undefined); })}>确认删除</button><button onClick={() => setDeleteId(undefined)}>取消删除</button></div></div>}
        </article>)}</div>
      </>}
    </div>
  </main>;
}
