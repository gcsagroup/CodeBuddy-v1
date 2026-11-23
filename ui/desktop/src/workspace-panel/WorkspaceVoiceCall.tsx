import { useEffect, useRef, useState } from 'react';
import { Phone, AudioLines, ChevronDown } from 'lucide-react';
import { AgentAvatar } from '../components/custom-agents/AgentAvatar';
import { agentRequest, type AgentProfile, type AgentSelection } from '../components/custom-agents/agentApi';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '../components/ui/dropdown-menu';
import { AppEvents } from '../constants/events';
import { mediaText } from './WorkspaceGeneration';

export function WorkspaceVoiceCall({ sessionId }: { sessionId: string }) {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const chosenId = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      setLoading(true);
      setError('');
      try {
        const [result, list] = await Promise.all([
          agentRequest<{ selection: AgentSelection }>('current', { sessionId }),
          agentRequest<{ profiles: AgentProfile[] }>('list'),
        ]);
        if (request === generation) {
          const current = result.selection.profile;
          const entries = current && !list.profiles.some(item => item.id === current.id)
            ? [current, ...list.profiles] : list.profiles;
          setProfiles(entries);
          setProfile(chosenId.current === null ? current : entries.find(item => item.id === chosenId.current) ?? null);
        }
      } catch {
        if (request === generation) setError(mediaText('Unable to load the current agent.', '无法加载当前智能体。', '無法載入目前智慧體。'));
      } finally {
        if (request === generation) setLoading(false);
      }
    };
    const admitted = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) void refresh();
    };
    void refresh();
    window.addEventListener(AppEvents.AGENT_PROFILES_CHANGED, refresh);
    window.addEventListener(AppEvents.AGENT_INPUT_ADMITTED, admitted);
    window.addEventListener('focus', refresh);
    return () => {
      generation++;
      window.removeEventListener(AppEvents.AGENT_PROFILES_CHANGED, refresh);
      window.removeEventListener(AppEvents.AGENT_INPUT_ADMITTED, admitted);
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto bg-background-default p-6" aria-label={mediaText('Voice call', '语音通话', '語音通話')}>
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <AudioLines size={16} />
        {mediaText('Voice conversation', '实时语音聊天', '即時語音聊天')}
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center py-12 text-center">
        <div className="mb-7 flex size-32 items-center justify-center rounded-full bg-violet-500/10 ring-8 ring-violet-500/5">
          <AgentAvatar avatar={loading || error ? 'app-logo' : (profile?.avatar ?? 'app-logo')} className="size-20 text-6xl" />
        </div>
        <div className="flex max-w-full items-center justify-center gap-2">
          <h2 className="min-w-0 break-words text-2xl font-semibold text-text-primary">
            {loading ? mediaText('Loading…', '正在加载…', '正在載入…') : error ? mediaText('Agent unavailable', '智能体暂不可用', '智慧體暫不可用') : profile?.name ?? mediaText('Default assistant', '默认助手', '預設助手')}
          </h2>
          {!loading && !error && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={mediaText('Choose call persona', '选择通话角色', '選擇通話角色')}
                  title={mediaText('Choose call persona', '选择通话角色', '選擇通話角色')}
                  className="group flex size-7 shrink-0 items-center justify-center rounded-full border border-border-primary bg-background-primary text-text-secondary transition-colors hover:bg-violet-500/10 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 data-[state=open]:bg-violet-500/10 data-[state=open]:text-violet-500"
                >
                  <ChevronDown size={14} className="transition-transform group-data-[state=open]:rotate-180" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" sideOffset={10} className="w-64 max-w-[calc(100vw-2rem)] p-1.5">
                <DropdownMenuRadioGroup
                  aria-label={mediaText('Call persona', '通话角色', '通話角色')}
                  value={profile?.id ?? ''}
                  onValueChange={id => {
                    chosenId.current = id;
                    setProfile(profiles.find(item => item.id === id) ?? null);
                  }}
                >
                  {[{ id: '', name: mediaText('Default assistant', '默认助手', '預設助手'), avatar: 'app-logo' }, ...profiles.filter(item => item.id)].map(item => (
                    <DropdownMenuRadioItem key={item.id} value={item.id ?? ''} textValue={item.name} className="gap-3 rounded-lg py-2.5 pr-3 data-[state=checked]:bg-violet-500/10">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-secondary">
                        <AgentAvatar avatar={item.avatar} className="size-7 text-xl" />
                      </span>
                      <span className="min-w-0 truncate" title={item.name}>{item.name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-red-500">{error}</p>}
      </div>
      <div className="flex flex-col items-center gap-3 pb-6">
        <button disabled className="flex items-center gap-3 rounded-full bg-violet-500/15 px-7 py-4 text-sm text-text-secondary disabled:cursor-not-allowed">
          <Phone size={19} />
          {mediaText('Start call', '开始通话', '開始通話')}
        </button>
        <p role="status" className="text-xs text-text-secondary">{mediaText('Waiting for voice service setup', '等待语音服务接入', '等待語音服務接入')}</p>
      </div>
    </section>
  );
}
