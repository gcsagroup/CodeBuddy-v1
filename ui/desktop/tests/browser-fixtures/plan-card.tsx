import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import '../../src/components/conversation-presentation.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: { platform: 'win32', logInfo: () => {}, on: () => () => {} },
});
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
applyThemeTokens(dark ? 'dark' : 'light');
document.documentElement.classList.add(dark ? 'dark' : 'light');
const { CodeProPlan } = await import('../../src/components/codepro/CodeProToolContent');
const content = [
  '[x] 检查工作区与可用运行环境，确定实现方式',
  '[x] 整理需求与页面结构',
  '[-] 实现教务管理系统的界面与核心交互',
  '[ ] 验证学生、教师、课程与排课管理的完整业务流程，同时检查窄窗口和长文本的显示效果',
  '[ ] 运行系统并验证响应式布局',
  '[ ] 检查错误提示与空状态',
  '[ ] 整理运行说明并交付可访问文件',
  '[ ] 完成最终验收',
].join('\n');
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="zh-CN" messages={{
    'codeProToolContent.plan': '任务',
    'codeProToolContent.planSummary': '{completed} 已完成 · {active} 进行中 · {pending} 待处理',
  }}>
    <main className="codepro-conversation" style={{ maxWidth: 850, margin: '20px auto', padding: 8 }}>
      <CodeProPlan compact active requestId="visual-plan" content={content}>fallback</CodeProPlan>
      <textarea aria-label="发送消息" style={{ width: '100%', marginTop: 12, height: 80 }} />
    </main>
  </IntlProvider>
);
