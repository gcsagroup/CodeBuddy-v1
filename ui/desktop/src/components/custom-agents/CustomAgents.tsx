import { AppEvents } from '../../constants/events';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot, Plus, ArrowLeft, Check, Loader2, Trash2, ImagePlus, AlertTriangle } from 'lucide-react';
import { setNextChatAgent } from '../../utils/nextChatAgent';
import { rememberRecentAgent } from '../../utils/recentAgents';
import { getWorkspaceModeFromPath, withWorkspaceMode, type ViewOptions } from '../../utils/navigationUtils';
import { agentRequest as request, type AgentProfile as Profile, type AgentPreset, type AgentSelection } from './agentApi';

import { AgentAvatar, readAvatar } from './AgentAvatar';

interface Choice { name: string; description?: string; title?: string; roleOnly?: boolean }
interface Catalog {
  skills: Choice[]; tools: Choice[]; mcpServers: Choice[];
  presets?: AgentPreset[];
}
const blank = (): Profile => ({ name: '', avatar: 'app-logo', prompt: '', skills: [], tools: [], mcpServers: [], capabilities: 'inherit' });
const fieldClass = 'w-full rounded-lg border border-border-primary bg-background-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-text-secondary';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-border-primary px-4 py-2 text-sm hover:bg-background-secondary disabled:opacity-50';
const builtinNameHint = '与内置模板同名，建议换个名称以便区分。保留此名称也不会覆盖模板。';

function AgentCard({ profile, description, tags, applyLabel, applyAriaLabel, disabled, onApply, confirmation, children }: {
  profile: Profile; description: string; tags: string[];
  applyLabel: string; applyAriaLabel?: string; disabled: boolean; onApply: () => void; confirmation?: ReactNode; children: ReactNode;
}) {
  return <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-primary px-5 py-4">
    <div className="flex items-center gap-3"><span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-background-secondary text-2xl"><AgentAvatar avatar={profile.avatar} /></span><h3 className="min-w-0 break-words text-base font-medium">{profile.name}</h3></div>
    <p className="line-clamp-2 h-10 overflow-hidden text-sm leading-5 text-text-secondary" title={description}>{description}</p>
    <ul aria-label="适用领域" className="flex min-h-7 flex-wrap gap-1.5">{tags.map(tag => <li key={tag} className="rounded bg-background-secondary px-2 py-1 text-xs text-text-secondary">{tag}</li>)}</ul>
    <div className="mt-auto flex items-center justify-between gap-3 pt-1"><button disabled={disabled} className="inline-flex shrink-0 items-center justify-center rounded-lg border border-border-primary px-3 py-1.5 text-sm hover:bg-background-secondary disabled:opacity-50" aria-label={applyAriaLabel} onClick={onApply}>{applyLabel}</button><div className="flex min-w-0 items-center gap-3 text-sm">{children}</div></div>
    {confirmation}
  </article>;
}

function Choices({ title, choices, selected, onChange }: { title: string; choices: Choice[]; selected: string[]; onChange: (values: string[]) => void }) {
  const entries: Choice[] = [...choices, ...selected.filter(name => !choices.some(c => c.name === name)).map(name => ({ name, description: '当前不可用；保留配置，不会自动替换' }))];
  return <fieldset className="rounded-xl border border-border-primary p-4">
    <legend className="px-1 text-sm font-medium">{title}（{selected.length}）</legend>
    <div className="mb-3 flex gap-4 text-xs"><button type="button" onClick={() => onChange(choices.map(c => c.name))}>全选</button><button type="button" onClick={() => onChange([])}>清空</button></div>
    <div className="max-h-56 space-y-2 overflow-y-auto">
      {!entries.length && <p className="text-sm text-text-secondary">暂无可用项，请先在工具箱中配置。</p>}
      {entries.map(c => <label key={c.name} className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-background-secondary">
        <input type="checkbox" className="mt-1 shrink-0" checked={selected.includes(c.name)} onChange={e => onChange(e.target.checked ? [...selected, c.name] : selected.filter(n => n !== c.name))} />
        <span className="min-w-0"><span className="block break-words text-sm">{c.title ?? c.name}</span>{!c.title && <span className="line-clamp-2 block text-xs text-text-secondary" title={c.description}>{c.description}</span>}</span>
      </label>)}
    </div>
  </fieldset>;
}

export function CustomAgents() {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionId = new URLSearchParams(location.search).get('sessionId');
  const returnPath = withWorkspaceMode(sessionId ? `/pair?resumeSessionId=${encodeURIComponent(sessionId)}` : '/', getWorkspaceModeFromPath(location.pathname));
  const applyLabel = sessionId ? '应用到当前对话' : '立即使用';
  const scope = useRef(0);
  const invalidate = useCallback(() => { scope.current++; }, []);
  const avatarInput = useRef<HTMLInputElement>(null);
  const editorForm = useRef<globalThis.HTMLFormElement>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [avatars, setAvatars] = useState<string[]>([]);
  const [showAllAvatars, setShowAllAvatars] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>();
  const roleSkills = catalog?.skills.filter(skill => skill.roleOnly) ?? [];
  const [draft, setDraft] = useState<Profile | undefined>(() => (location.state as ViewOptions | null)?.section === 'create' ? blank() : undefined);
  const [target, setTarget] = useState<{ sessionId: string; selection: AgentSelection } | null>(null);
  const visibleAvatars = showAllAvatars ? avatars : avatars.slice(0, 10);
  const avatarChoices = draft && !visibleAvatars.includes(draft.avatar) ? [...visibleAvatars, draft.avatar] : visibleAvatars;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteId, setDeleteId] = useState<string>();
  const targetReady = !sessionId || target?.sessionId === sessionId;
  const legacy = Boolean(sessionId && target?.sessionId === sessionId && target.selection.legacy);
  const editing = Boolean(draft && catalog);
  const draftName = draft?.name.trim().toLowerCase();
  const matchesBuiltinName = Boolean(draftName && catalog?.presets?.some(preset =>
    preset.profile.name.trim().toLowerCase() === draftName));
  const load = useCallback(async () => {
    const current = scope.current;
    setError(''); setBusy(true);
    try {
      const [list, available, currentRole] = await Promise.all([
        request<{ profiles: Profile[]; avatars: string[] }>('list'), request<Catalog>('catalog'),
        sessionId ? request<{ selection: AgentSelection }>('current', { sessionId }) : null,
      ]);
      if (current !== scope.current) return;
      setProfiles(list.profiles); setAvatars(['app-logo', ...list.avatars.filter(avatar => avatar !== 'app-logo')]); setCatalog(available);
      setTarget(sessionId && currentRole ? { sessionId, selection: currentRole.selection } : null);
    } catch (e) { if (current === scope.current) setError(e instanceof Error ? e.message : '加载失败，请重试'); }
    finally { if (current === scope.current) setBusy(false); }
  }, [sessionId]);
  useEffect(() => {
    invalidate(); setTarget(null); void load();
    return invalidate;
  }, [load, invalidate]);
  async function run(action: (current: number) => Promise<void>) {
    const current = scope.current;
    setBusy(true); setNotice('');
    try { await action(current); if (current === scope.current) setError(''); } catch (e) { if (current === scope.current) setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { if (current === scope.current) setBusy(false); }
  }
  async function saveProfile(draft: Profile, current: number) {
    const { profile } = await request<{ profile: Profile }>('save', { profile: draft });
    window.dispatchEvent(new Event(AppEvents.AGENT_PROFILES_CHANGED));
    if (current === scope.current) setProfiles(items => [...items.filter(p => p.id !== profile.id), profile]);
    return profile;
  }
  async function applyProfile(profile: Profile, current: number) {
    if (!profile.id || current !== scope.current) return;
    if (sessionId) {
      if (target?.sessionId !== sessionId) throw Error('尚未读取目标对话，请重新加载。');
      await request('select', { sessionId, id: profile.id, expectedRevision: target.selection.revision });
      window.dispatchEvent(new Event(AppEvents.AGENT_PROFILES_CHANGED));
    } else setNextChatAgent(profile.id);
    rememberRecentAgent(profile.id);
    if (current === scope.current) navigate(returnPath);
  }
  async function saveDraft(apply: boolean) {
    if (!draft) return;
    await run(async current => {
      const saved = await saveProfile(draft, current);
      if (current !== scope.current) return;
      // Keep the saved ID if applying fails, so retrying cannot create copies.
      setDraft(saved);
      if (apply) {
        try { await applyProfile(saved, current); }
        catch (e) { if (current === scope.current) setNotice('智能体已保存，尚未应用。'); throw e; }
      } else { setDraft(undefined); setNotice('智能体已保存，可在聊天中选用。'); }
    });
  }
  function update<K extends keyof Profile>(key: K, value: Profile[K]) {
    setDraft(d => d ? { ...d, [key]: value } : d);
    setError('');
    setNotice('');
  }
  return <main className="h-full overflow-y-auto bg-background-primary text-text-primary">
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 md:px-10">
      <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-2xl font-semibold"><Bot size={27} />自定义智能体</h1><p className="mt-2 max-w-2xl text-sm text-text-secondary">为不同工作配置专属助手，在同一对话中随时选用、切换或恢复默认助手。</p></div>
        <div className="flex flex-wrap gap-2"><button className={buttonClass} onClick={() => navigate(returnPath)}><ArrowLeft size={16} />{sessionId ? '返回对话' : '返回新对话'}</button>{!draft && <button className={buttonClass} disabled={!catalog || busy} onClick={() => { setDraft(blank()); setNotice(''); setError(''); }}><Plus size={16} />新建智能体</button>}</div>
      </header>
      {!editing && error && <div role="alert" className="rounded-xl border border-red-400/40 p-4 text-sm">{error} <button className="ml-3 underline" onClick={() => void load()} disabled={busy}>重新加载</button></div>}
      {!editing && notice && <p role="status" className="flex items-center gap-2 text-sm"><Check size={16} />{notice}</p>}
      {!editing && busy && <p role="status" className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" />正在处理…</p>}
      {legacy && <p className="text-sm text-text-secondary">这是旧工作区角色，请返回对话并在智能体菜单中转换后再应用；原有能力限制会保留。</p>}
      {draft && catalog ? <form ref={editorForm} onSubmit={e => { e.preventDefault(); void saveDraft(true); }} className="space-y-6 rounded-2xl border border-border-primary p-5 md:p-7">
        <fieldset disabled={busy} className="space-y-6">
          <div className="flex items-center justify-between"><h2 className="text-lg font-medium">{draft.id ? '编辑智能体' : '创建智能体'}</h2><button type="button" className={buttonClass} onClick={() => { setDraft(undefined); setError(''); setNotice(''); }}>取消</button></div>
          <div><p className="mb-2 text-sm font-medium">头像</p><div id="custom-agent-avatars" className="flex flex-wrap gap-2" role="group" aria-label="头像">
            {avatarChoices.map(avatar => <button key={avatar} type="button" aria-label={avatar === 'app-logo' ? '头像 应用 Logo' : avatar.startsWith('data:') ? '头像 自定义图片' : '头像 ' + avatar} aria-pressed={draft.avatar === avatar} onClick={() => update('avatar', avatar)} className={'flex size-14 items-center justify-center rounded-xl border text-2xl ' + (draft.avatar === avatar ? 'border-text-primary bg-background-secondary' : 'border-border-primary')}><AgentAvatar avatar={avatar} /></button>)}
            <button type="button" aria-label="上传头像" className="flex h-14 items-center justify-center gap-2 rounded-xl border border-dashed border-border-primary px-3 text-sm text-text-secondary hover:bg-background-secondary" onClick={() => avatarInput.current?.click()}><ImagePlus size={20} />上传图片</button>
            <input ref={avatarInput} type="file" aria-label="头像图片文件" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { update('avatar', await readAvatar(file)); }); }} />
          </div><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">{avatars.length > 10 && <button type="button" aria-expanded={showAllAvatars} aria-controls="custom-agent-avatars" className="text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary" onClick={() => setShowAllAvatars(value => !value)}>{showAllAvatars ? '收起头像' : `更多头像（${avatars.length}）`}</button>}<p className="text-xs text-text-secondary">可上传自己的图片：PNG、JPEG、WebP，最大 5 MB；自动居中裁剪为方形。</p></div></div>
          <div className="space-y-2">
            <div className="flex h-5 min-w-0 items-center gap-3">
              <label htmlFor="custom-agent-name" className="shrink-0 text-sm">名称</label>
              {matchesBuiltinName && <p id="agent-name-template-hint" role="status" className="min-w-0 truncate text-xs leading-5 text-text-secondary" title={builtinNameHint}>{builtinNameHint}</p>}
            </div>
            <input id="custom-agent-name" required maxLength={80} className={fieldClass} value={draft.name} onChange={e => update('name', e.target.value)} placeholder="例如：写作搭档" aria-describedby={matchesBuiltinName ? 'agent-name-template-hint' : undefined} />
          </div>
          <label className="block space-y-2 text-sm">人设提示词<textarea required maxLength={32000} rows={6} className={fieldClass} value={draft.prompt} onChange={e => update('prompt', e.target.value)} placeholder="描述角色身份、沟通风格、擅长的任务，以及需要遵守的规则。" /></label>
          <div className="space-y-3"><p className="text-sm text-text-secondary">已有功能与当前对话保持一致。可按需要添加配套技能；不选也能正常使用，操作权限保持不变。</p>
          {draft.capabilities === 'inherit' && roleSkills.length > 0 && <Choices title="配套技能" choices={roleSkills}
            selected={draft.skills.filter(name => roleSkills.some(skill => skill.name === name))}
            onChange={values => update('skills', [...draft.skills.filter(name => !roleSkills.some(skill => skill.name === name)), ...values])} />}</div>
          {draft.capabilities !== 'inherit' && <details className="rounded-xl border border-border-primary p-4"><summary className="cursor-pointer text-sm">高级设置：保留旧版能力限制</summary><p className="my-3 text-sm text-text-secondary">这个智能体已有单独的能力限制，保存时继续保留。</p><div className="grid gap-4 lg:grid-cols-3"><Choices title="配套技能" choices={catalog.skills} selected={draft.skills} onChange={v => update('skills', v)} /><Choices title="可用工具" choices={catalog.tools} selected={draft.tools} onChange={v => update('tools', v)} /><Choices title="连接服务" choices={catalog.mcpServers} selected={draft.mcpServers} onChange={v => update('mcpServers', v)} /></div></details>}
          <div className="space-y-3 border-t border-border-primary pt-4">
            <div className="min-h-11">
              {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-background-danger/10 px-3 py-2.5 text-sm text-text-danger">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <p className="min-w-0 break-words leading-5">{error}</p>
              </div>}
              {notice && <p role="status" className="mt-2 text-sm text-text-secondary">{notice}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="grid min-w-0 text-xs text-text-secondary">
                <p className={'col-start-1 row-start-1 ' + (busy ? 'invisible' : '')}>仅保存不会改变已有对话；保存并应用会回到来源对话。</p>
                {busy && <p role="status" className="col-start-1 row-start-1 flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />正在处理…</p>}
              </div>
              <div className="grid shrink-0 grid-cols-2 gap-3">
                <button type="button" className={buttonClass} onClick={() => { if (editorForm.current?.reportValidity()) void saveDraft(false); }}>仅保存</button>
                <button type="submit" disabled={!targetReady || legacy} className={buttonClass}>保存并应用</button>
              </div>
            </div>
          </div>
        </fieldset>
      </form> : <>
        {!!catalog?.presets?.length && <section aria-labelledby="agent-presets-heading" className="space-y-4">
          <div><h2 id="agent-presets-heading" className="text-base font-medium">默认模板</h2><p className="mt-1 text-sm text-text-secondary">直接应用即可使用，也可自定义后保存。配套技能会随角色加载，模型与权限沿用当前对话。</p></div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{catalog.presets.map(preset => <AgentCard key={preset.key}
            profile={preset.profile} description={preset.description} tags={preset.tags}
            applyLabel={applyLabel} applyAriaLabel={`${applyLabel} ${preset.profile.name}`} disabled={busy || !targetReady || legacy}
            onApply={() => void run(current => applyProfile(preset.profile, current))}>
              <button disabled={busy} className="text-sm text-text-secondary hover:text-text-primary" aria-label={`自定义 ${preset.profile.name}`} onClick={() => { setDraft({ ...structuredClone(preset.profile), id: undefined, revision: undefined }); setNotice(''); setError(''); }}>自定义</button>
          </AgentCard>)}</div>
        </section>}
        {!busy && catalog && !profiles.length && !catalog.presets?.length && <div className="rounded-2xl border border-dashed border-border-primary px-6 py-16 text-center"><Bot className="mx-auto mb-4 text-text-secondary" size={40} /><h2 className="text-lg font-medium">创建你的第一个智能体</h2><p className="mt-2 text-sm text-text-secondary">写作、研究、设计或开发，为不同工作准备专属搭档。</p></div>}
        {!!profiles.length && <h2 className="pt-2 text-base font-medium">我的智能体</h2>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{profiles.map(profile => <AgentCard key={profile.id}
          profile={profile} description={profile.prompt} tags={[profile.capabilities === 'inherit' ? '自定义智能体' : '保留原有能力限制']}
          applyLabel={applyLabel} applyAriaLabel={`${applyLabel} ${profile.name}`} disabled={busy || !targetReady || legacy} onApply={() => void run(current => applyProfile(profile, current))}
          confirmation={deleteId === profile.id && <div className="space-y-3 border-t border-border-primary pt-3 text-sm"><p>删除此智能体？已有对话及已选角色版本会保留。</p><div className="flex gap-4"><button disabled={busy} onClick={() => void run(async () => { await request('delete', { id: profile.id }); window.dispatchEvent(new Event(AppEvents.AGENT_PROFILES_CHANGED)); setProfiles(items => items.filter(p => p.id !== profile.id)); setDeleteId(undefined); })}>确认删除</button><button onClick={() => setDeleteId(undefined)}>取消删除</button></div></div>}>
          <button disabled={busy} onClick={() => { setDraft(structuredClone(profile)); setError(''); }}>编辑</button><button disabled={busy} onClick={() => { setDraft({ ...structuredClone(profile), id: undefined, revision: undefined, name: `${profile.name.slice(0, 76)} 副本` }); setError(''); }}>复制</button><button aria-label={`删除 ${profile.name}`} disabled={busy} onClick={() => setDeleteId(profile.id)}><Trash2 size={15} /></button>
        </AgentCard>)}</div>
      </>}
    </div>
  </main>;
}
