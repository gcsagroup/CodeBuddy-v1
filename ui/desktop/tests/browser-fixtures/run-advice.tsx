import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { RunAdviceCard } from '../../src/components/RunAdviceCard';
import type { RunAdvice } from '../../src/components/codepro/useWorkStatus';
import { loadMessages } from '../../src/i18n';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';

const locale = new URLSearchParams(location.search).get('locale') || 'zh-CN';
applyThemeTokens('light');
function Fixture() {
  const [kind, setKind] = useState<RunAdvice['kind']>('responses');
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stops, setStops] = useState(0);
  return <main className="mx-auto max-w-3xl pt-12 font-sans text-text-primary">
    <RunAdviceCard advice={kind === 'responses' || kind === 'tools' ? {kind, count:3} : {kind, seconds:180}}
      attemptId={String(attempt)} stopping={stopping}
      statusMessage="正在重试模型请求（3/5），约 3 秒后尝试；请求失败，具体原因尚未确认。"
      onStopAndChoose={()=>{setStops(stops+1);setStopping(true);}} />
    <div className="mx-4 rounded-2xl border border-border-primary p-5 text-sm text-text-secondary">{locale === 'en' ? 'Send a message…' : '发送消息，与 CodeBuddy 一起工作…'}</div>
    <nav className="mt-12 flex flex-wrap gap-4 px-4 text-xs">
      {(['responses','tools','waiting','generation'] as const).map(value=><button key={value} onClick={()=>{setKind(value);setAttempt(attempt+1);setStopping(false);}}>{value}</button>)}
      <button onClick={()=>{const dark=document.documentElement.classList.toggle('dark');applyThemeTokens(dark ? 'dark' : 'light');}}>theme</button>
      <span data-testid="stops">{stops}</span>
    </nav>
  </main>;
}
void loadMessages(locale).then(messages=>createRoot(document.getElementById('root')!).render(<IntlProvider locale={locale} messages={messages}><Fixture /></IntlProvider>));
