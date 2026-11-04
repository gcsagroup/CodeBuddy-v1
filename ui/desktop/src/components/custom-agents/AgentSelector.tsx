import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, Search } from 'lucide-react';
import { AppEvents } from '../../constants/events';
import {
  getNextChatAgent,
  NEXT_CHAT_AGENT_CHANGED,
  setNextChatAgent,
} from '../../utils/nextChatAgent';
import { agentRequest, type AgentPreset, type AgentProfile, type AgentSelection } from './agentApi';
import { AgentAvatar } from './AgentAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export function AgentSelector({
  sessionId,
  busy,
  openRequest = 0,
  onManage,
}: {
  sessionId: string | null;
  busy: boolean;
  openRequest?: number;
  onManage?: (create?: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<AgentSelection>({
    revision: 0,
    profile: null,
    legacy: false,
  });
  const [draftId, setDraftId] = useState(getNextChatAgent);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('codebuddy:recent-agents') ?? '[]');
      return Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === 'string').slice(0, 5)
        : [];
    } catch {
      return [];
    }
  });
  const remember = (id: string | null) => {
    if (!id) return;
    setRecent((previous) => {
      const next = [id, ...previous.filter((item) => item !== id)].slice(0, 5);
      try {
        localStorage.setItem('codebuddy:recent-agents', JSON.stringify(next));
      } catch {
        /* The display preference must not block role selection. */
      }
      return next;
    });
  };
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const generation = useRef(0);
  const saveOperation = useRef<{ sessionId: string; reload: boolean } | null>(null);
  const latestLoad = useRef<(() => Promise<void>) | null>(null);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const load = useCallback(async () => {
    if (sessionId && saveOperation.current?.sessionId === sessionId) {
      saveOperation.current.reload = true;
      return;
    }
    const current = ++generation.current;
    try {
      const [list, chosen] = await Promise.all([
        agentRequest<{ profiles: AgentProfile[]; presets?: AgentPreset[] }>('list'),
        sessionId
          ? agentRequest<{
              selection: AgentSelection;
              effective?: AgentProfile | null;
              pending?: boolean;
              unavailable?: string[];
            }>('current', { sessionId })
          : null,
      ]);
      if (current !== generation.current) return;
      setProfiles(list.profiles);
      setPresets(list.presets ?? []);
      setLoaded(true);
      setSelection(chosen?.selection ?? { revision: 0, profile: null, legacy: false });
      setUnavailable(chosen?.unavailable ?? []);
      setError('');
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : '无法加载自定义智能体');
    }
  }, [sessionId]);
  useEffect(() => {
    latestLoad.current = load;
    setSaving(false);
    setLoaded(false);
    setSelection({ revision: 0, profile: null, legacy: false });
    setUnavailable([]);
    setError('');
    const draftChanged = () => setDraftId(getNextChatAgent());
    const refresh = () => void load();
    const admitted = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId)
        void load();
    };
    window.addEventListener(AppEvents.AGENT_PROFILES_CHANGED, refresh);
    window.addEventListener(AppEvents.AGENT_INPUT_ADMITTED, admitted);
    window.addEventListener('focus', refresh);
    window.addEventListener(NEXT_CHAT_AGENT_CHANGED, draftChanged);
    return () => {
      invalidate();
      latestLoad.current = null;
      window.removeEventListener(AppEvents.AGENT_PROFILES_CHANGED, refresh);
      window.removeEventListener(AppEvents.AGENT_INPUT_ADMITTED, admitted);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(NEXT_CHAT_AGENT_CHANGED, draftChanged);
    };
  }, [load, invalidate, sessionId]);
  // A turn ending refreshes native adoption; it does not invalidate the
  // in-flight selection write. Its receipt still belongs to this conversation.
  useEffect(() => {
    void load();
  }, [load, busy]);
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);
  const choose = async (id: string | null, action: 'select' | 'convert' = 'select') => {
    if (!sessionId) {
      setNextChatAgent(id);
      remember(id);
      return;
    }
    const current = ++generation.current;
    const operation = { sessionId, reload: false };
    saveOperation.current = operation;
    setSaving(true);
    setError('');
    try {
      const result = await agentRequest<{
        selection: AgentSelection;
        pending: boolean;
        effective?: AgentProfile | null;
        unavailable?: string[];
      }>(action, {
        sessionId,
        ...(action === 'select' ? { id } : {}),
        expectedRevision: selection.revision,
      });
      if (current !== generation.current) return;
      setSelection(result.selection);
      remember(result.selection.profile?.id ?? null);
      setUnavailable(result.unavailable ?? []);
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : '切换智能体失败');
    } finally {
      if (saveOperation.current === operation) {
        saveOperation.current = null;
        if (latestLoad.current) {
          setSaving(false);
          if (operation.reload) void latestLoad.current();
        }
      }
    }
  };
  const selectedId = sessionId ? (selection.profile?.id ?? '') : (draftId ?? '');
  const allProfiles = [...profiles, ...presets.map((preset) => preset.profile)];
  const entries =
    selection.profile && !allProfiles.some((profile) => profile.id === selection.profile?.id)
      ? [selection.profile, ...profiles]
      : profiles;
  const uniqueProfiles = [
    ...new Map(
      [...entries, ...presets.map((preset) => preset.profile)].map((profile) => [
        profile.id,
        profile,
      ])
    ).values(),
  ];
  const recentProfiles = recent
    .map((id) => uniqueProfiles.find((profile) => profile.id === id))
    .filter((profile): profile is AgentProfile => Boolean(profile));
  const defaults = (presets.length ? presets.map((preset) => preset.profile) : entries).slice(0, 5);
  const currentProfile = uniqueProfiles.find((profile) => profile.id === selectedId);
  const recommended = [
    ...new Map(
      [...(currentProfile ? [currentProfile] : []), ...recentProfiles, ...defaults].map(
        (profile) => [profile.id, profile]
      )
    ).values(),
  ];
  const visibleProfiles = query.trim()
    ? uniqueProfiles.filter((profile) =>
        profile.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      )
    : recommended;
  const selected = sessionId
    ? selection.profile
    : allProfiles.find((profile) => profile.id === draftId);
  const missingDraft = !sessionId && draftId && loaded && !selected;
  const showSelection = Boolean(selected || missingDraft);
  const updateAvailable =
    sessionId &&
    !selection.legacy &&
    selected &&
    allProfiles.some(
      (profile) => profile.id === selected.id && (profile.revision ?? 0) > (selected.revision ?? 0)
    );
  const roleSummary = selected?.name;
  return (
    <div className="relative flex min-w-0 max-w-40 items-center text-xs text-text-secondary">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="自定义智能体"
            title={roleSummary}
            aria-hidden={!showSelection}
            tabIndex={showSelection ? 0 : -1}
            disabled={saving}
            className={
              showSelection
                ? 'flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 hover:bg-background-secondary focus-visible:outline focus-visible:outline-2'
                : 'pointer-events-none absolute size-px opacity-0'
            }
          >
            {selected && (
              <>
                <AgentAvatar avatar={selected.avatar} className="size-4 shrink-0" />
                <span
                  className="min-w-0 max-w-28 truncate @max-[36rem]/composer:hidden"
                  title={selected.name}
                >
                  {selected.name}
                </span>
                <ChevronDown size={12} className="shrink-0" />
              </>
            )}
            {missingDraft && (
              <>
                <Bot size={16} />
                <span className="@max-[36rem]/composer:hidden">智能体不可用</span>
                <ChevronDown size={12} />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="flex w-60 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl p-1.5"
          style={{ maxHeight: 'min(26rem, var(--radix-dropdown-menu-content-available-height))' }}
        >
          <label className="mb-1 flex shrink-0 items-center gap-2 rounded-lg bg-background-secondary px-2.5 py-2 text-text-secondary">
            <Search size={14} className="shrink-0" />
            <input
              ref={searchRef}
              type="search"
              aria-label="搜索智能体"
              placeholder="搜索智能体"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') event.stopPropagation();
              }}
              className="min-w-0 w-full border-0 bg-transparent text-xs outline-none"
            />
          </label>
          {missingDraft && (
            <p role="status" className="px-2 py-2 text-xs text-text-secondary">
              所选智能体已删除，请重新选择或恢复默认助手。
            </p>
          )}
          {selection.legacy && (
            <>
              <div className="space-y-1 px-2 py-2 text-xs text-text-secondary">
                <p className="font-medium">旧工作区角色</p>
                <p>转换后可在本对话切换或撤销智能体；原有工具、服务及权限限制继续保留。</p>
              </div>
              <DropdownMenuItem disabled={saving} onSelect={() => void choose(null, 'convert')}>
                转换为可切换智能体
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuRadioGroup
            value={selectedId}
            onValueChange={(id) => void choose(id || null)}
            className="min-h-0 overflow-y-auto"
            style={{ maxHeight: '18rem', scrollbarGutter: 'stable' }}
          >
            <DropdownMenuRadioItem
              indicator="none"
              className="h-9 rounded-lg py-2 text-xs leading-5"
              value=""
              disabled={saving || !loaded || selection.legacy}
            >
              默认助手
            </DropdownMenuRadioItem>
            <DropdownMenuLabel className="text-[11px] font-normal text-text-secondary">
              {query.trim()
                ? '搜索结果'
                : recentProfiles.length
                  ? '最近使用与默认模板'
                  : '默认模板'}
            </DropdownMenuLabel>
            {visibleProfiles.map((profile) => (
              <DropdownMenuRadioItem
                indicator="none"
                key={profile.id}
                value={profile.id ?? ''}
                disabled={saving || !loaded || selection.legacy}
                className="h-9 gap-2 rounded-lg py-2 text-xs leading-5"
              >
                <AgentAvatar avatar={profile.avatar} className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{profile.name}</span>
              </DropdownMenuRadioItem>
            ))}
            {query.trim() && !visibleProfiles.length && (
              <p className="px-2 py-3 text-xs text-text-secondary">没有匹配的智能体</p>
            )}
          </DropdownMenuRadioGroup>
          {updateAvailable && (
            <DropdownMenuItem disabled={saving} onSelect={() => void choose(selected.id ?? null)}>
              应用更新
            </DropdownMenuItem>
          )}
          {unavailable.length > 0 && (
            <p role="status" className="px-2 py-2 text-xs text-text-secondary">
              资源提示：{unavailable.join('、')}。未启用的服务不会自动开启。
            </p>
          )}
          {onManage && (
            <div className="shrink-0">
              <DropdownMenuSeparator />
              <DropdownMenuItem className="h-9 rounded-lg text-xs" onSelect={() => onManage()}>
                管理自定义智能体
              </DropdownMenuItem>
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span
          role="alert"
          className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-lg bg-background-primary p-3 text-xs text-red-600 shadow-md"
        >
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            重新加载
          </button>
        </span>
      )}
    </div>
  );
}
