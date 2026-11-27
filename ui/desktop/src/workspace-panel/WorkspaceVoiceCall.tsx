/* global HTMLParagraphElement */
import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, AudioLines, ChevronDown } from 'lucide-react';
import { VoiceCall } from './voice/VoiceCall';
import { AgentAvatar } from '../components/custom-agents/AgentAvatar';
import {
  agentRequest,
  type AgentProfile,
  type AgentSelection,
} from '../components/custom-agents/agentApi';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../components/ui/dropdown-menu';
import { AppEvents } from '../constants/events';
import { mediaText } from './WorkspaceGeneration';

export function WorkspaceVoiceCall({ sessionId }: { sessionId: string }) {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const chosenId = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const call = useRef<VoiceCall | null>(null);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'active'>('idle');
  const [status, setStatus] = useState('准备好后，开始通话');
  const [callError, setCallError] = useState('');
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState('');
  const captions = useRef<HTMLParagraphElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const active = phase !== 'idle';
  useEffect(() => {
    if (captions.current) captions.current.scrollTop = captions.current.scrollHeight;
  }, [transcript]);
  useEffect(() => {
    chosenId.current = null;
    setPhase('idle');
    setStatus('准备好后，开始通话');
    setCallError('');
    setTranscript('');
    setLevel(0);
    setElapsed(0);
    setMuted(false);
    return () => {
      const current = call.current;
      call.current = null;
      current?.stop();
    };
  }, [sessionId]);
  useEffect(() => {
    if (phase !== 'active') return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  const start = () => {
    if (call.current) return;
    setPhase('connecting');
    setMuted(false);
    setLevel(0);
    setElapsed(0);
    setCallError('');
    setTranscript('');
    const current = new VoiceCall({
      replyStart: () => {
        if (call.current === current) setTranscript('');
      },
      status: (value) => {
        if (call.current === current) setStatus(value);
      },
      ready: () => {
        if (call.current === current) {
          setPhase('active');
          setStatus('通话中');
        }
      },
      level: (value) => {
        if (call.current === current) setLevel(value);
      },
      text: (value) => {
        if (call.current === current) setTranscript((previous) => (previous + value).slice(-4000));
      },
      ended: (message) => {
        if (call.current !== current) return;
        call.current = null;
        setPhase('idle');
        setLevel(0);
        setStatus(message ? '连接未完成' : '通话已结束');
        setCallError(message ?? '');
      },
    });
    call.current = current;
    void current.start({
      name: profile?.name ?? 'CodeBuddy',
      prompt: profile?.prompt || '你是一位友善、耐心的聊天伙伴，以自然的口语与用户聊天。',
    });
  };
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      if (call.current) return;
      const request = ++generation;
      setLoading(true);
      setError('');
      try {
        const [result, list] = await Promise.all([
          agentRequest<{ selection: AgentSelection }>('current', { sessionId }),
          agentRequest<{ profiles: AgentProfile[] }>('list'),
        ]);
        if (request === generation && !call.current) {
          const current = result.selection.profile;
          const entries =
            current && !list.profiles.some((item) => item.id === current.id)
              ? [current, ...list.profiles]
              : list.profiles;
          setProfiles(entries);
          setProfile(
            chosenId.current === null
              ? current
              : (entries.find((item) => item.id === chosenId.current) ?? null)
          );
        }
      } catch {
        if (request === generation)
          setError(
            mediaText(
              'Unable to load the current agent.',
              '无法加载当前智能体。',
              '無法載入目前智慧體。'
            )
          );
      } finally {
        if (request === generation) setLoading(false);
      }
    };
    const admitted = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId)
        void refresh();
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
    <section
      className="flex min-h-0 flex-1 flex-col overflow-auto bg-background-default p-6"
      aria-label={mediaText('Voice call', '语音通话', '語音通話')}
    >
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <AudioLines size={16} />
        {mediaText('Voice conversation', '实时语音聊天', '即時語音聊天')}
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center py-12 text-center">
        <div className="mb-7 flex size-32 items-center justify-center rounded-full bg-violet-500/10 ring-8 ring-violet-500/5">
          <AgentAvatar
            avatar={loading || error ? 'app-logo' : (profile?.avatar ?? 'app-logo')}
            className="size-20 text-6xl"
          />
        </div>
        <div className="flex max-w-full items-center justify-center gap-2">
          <h2 className="min-w-0 break-words text-2xl font-semibold text-text-primary">
            {loading
              ? mediaText('Loading…', '正在加载…', '正在載入…')
              : error
                ? mediaText('Agent unavailable', '智能体暂不可用', '智慧體暫不可用')
                : (profile?.name ?? mediaText('Default assistant', '默认助手', '預設助手'))}
          </h2>
          {!loading && !error && !active && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={mediaText('Choose call persona', '选择通话角色', '選擇通話角色')}
                  title={mediaText('Choose call persona', '选择通话角色', '選擇通話角色')}
                  className="group flex size-7 shrink-0 items-center justify-center rounded-full border border-border-primary bg-background-primary text-text-secondary transition-colors hover:bg-violet-500/10 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 data-[state=open]:bg-violet-500/10 data-[state=open]:text-violet-500"
                >
                  <ChevronDown
                    size={14}
                    className="transition-transform group-data-[state=open]:rotate-180"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="center"
                sideOffset={10}
                className="w-64 max-w-[calc(100vw-2rem)] p-1.5"
              >
                <DropdownMenuRadioGroup
                  aria-label={mediaText('Call persona', '通话角色', '通話角色')}
                  value={profile?.id ?? ''}
                  onValueChange={(id) => {
                    chosenId.current = id;
                    setProfile(profiles.find((item) => item.id === id) ?? null);
                  }}
                >
                  {[
                    {
                      id: '',
                      name: mediaText('Default assistant', '默认助手', '預設助手'),
                      avatar: 'app-logo',
                    },
                    ...profiles.filter((item) => item.id),
                  ].map((item) => (
                    <DropdownMenuRadioItem
                      key={item.id}
                      value={item.id ?? ''}
                      textValue={item.name}
                      className="gap-3 rounded-lg py-2.5 pr-3 data-[state=checked]:bg-violet-500/10"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-secondary">
                        <AgentAvatar avatar={item.avatar} className="size-7 text-xl" />
                      </span>
                      <span className="min-w-0 truncate" title={item.name}>
                        {item.name}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-500">
            {error}
          </p>
        )}
        {phase === 'active' && (
          <>
            <p className="mt-3 font-mono text-sm text-text-secondary">
              {Math.floor(elapsed / 60)
                .toString()
                .padStart(2, '0')}
              :{(elapsed % 60).toString().padStart(2, '0')}
            </p>
            <div
              className="mt-6 flex h-12 items-center gap-1"
              aria-label={muted ? '麦克风已静音' : '麦克风音量'}
            >
              {Array.from({ length: 21 }, (_, index) => (
                <span
                  key={index}
                  className="w-1 rounded-full bg-violet-500 transition-all duration-75"
                  style={{
                    height: `${4 + Math.min(1, level * 8) * 40 * (1 - Math.abs(index - 10) / 12)}px`,
                    opacity: muted ? 0.25 : 0.75,
                  }}
                />
              ))}
            </div>
          </>
        )}
        <div className="mt-5 w-full rounded-2xl border border-border-primary bg-background-secondary/50 px-5 py-4 text-left">
          <div className="mb-2 text-xs font-medium text-text-secondary">
            实时字幕 · {profile?.name ?? 'CodeBuddy'}
          </div>
          <p
            ref={captions}
            aria-label="对方说的话"
            aria-live="polite"
            className="max-h-36 min-h-16 w-full overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-text-primary"
          >
            {transcript}
          </p>
          {!transcript.trim() && (
            <p className="-mt-16 min-h-16 pointer-events-none text-sm leading-relaxed text-text-secondary">
              {phase === 'active'
                ? '等待对方回复…'
                : phase === 'connecting'
                  ? '接通后，回复字幕会显示在这里'
                  : '开始通话后，在这里查看对方的回复'}
            </p>
          )}
        </div>
        {callError && (
          <p role="alert" className="mt-4 text-sm text-red-500">
            {callError}
          </p>
        )}
      </div>
      <div className="flex flex-col items-center gap-3 pb-6">
        <div className="flex items-center gap-4">
          {phase === 'active' && (
            <button
              type="button"
              disabled={muted}
              onClick={() => call.current?.finishUtterance()}
              className="rounded-full border border-border-primary px-4 py-3 text-sm text-text-secondary disabled:opacity-40"
              title="环境嘈杂时，点击手动结束这一句"
            >
              说完了
            </button>
          )}
          {phase === 'active' && (
            <button
              type="button"
              aria-label={muted ? '取消静音' : '静音'}
              aria-pressed={muted}
              onClick={() => {
                call.current?.mute(!muted);
                setMuted(!muted);
              }}
              className="flex size-12 items-center justify-center rounded-full bg-background-secondary text-text-primary hover:bg-violet-500/10"
            >
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
          )}
          <button
            type="button"
            disabled={!active && (loading || !!error)}
            onClick={() => (active ? call.current?.stop() : start())}
            className={`flex items-center gap-3 rounded-full px-7 py-4 text-sm text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-red-500 hover:bg-red-600' : 'bg-violet-600 hover:bg-violet-500'}`}
          >
            {active ? <PhoneOff size={19} /> : <Phone size={19} />}
            {active
              ? phase === 'connecting'
                ? '取消连接'
                : '结束通话'
              : mediaText('Start call', '开始通话', '開始通話')}
          </button>
        </div>
        <p role="status" className="text-xs text-text-secondary">
          {phase === 'active' && muted ? '麦克风已静音' : status}
        </p>
      </div>
    </section>
  );
}
