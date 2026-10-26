import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { loadMessages } from '../../src/i18n';
import { requestAcpPermission } from '../../src/acp/permissionRequests';
import { acpChatSessionStore } from '../../src/acp/chatSessionStore';
import ToolApprovalButtons from '../../src/components/ToolApprovalButtons';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';

applyThemeTokens('light');
const toolName = new URLSearchParams(location.search).get('tool') ?? 'generate_video';
const labels: Record<string, string> = {
  generate_image: '生成图片',
  generate_video: '生成视频',
  browser_control: '浏览器控制',
  create_desktop_pet: '制作桌面宠物',
  project_memory: '项目记忆',
  list_mcp_resources: '列出资源',
  list_mcp_resource_templates: '列出资源模板',
  read_mcp_resource: '读取资源',
};
const request: RequestPermissionRequest = {
  sessionId: 'media-approval-browser',
  toolCall: {
    toolCallId: 'permission',
    title: toolName,
    status: 'pending',
    kind: 'execute',
    rawInput: { operation: 'generate' },
  },
  options: [
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Allow this tool for this session', kind: 'allow_always' },
  ],
  _meta: { codepro: { authorizationScope: 'session', extensionSource: 'builtin' } },
};
// Exercise the production ACP adapter and pending-request registry, not injected button state.
void requestAcpPermission(request).then((reply) => {
  document.getElementById('reply')!.textContent = JSON.stringify(reply);
});
const action = acpChatSessionStore
  .getSnapshot(request.sessionId)!
  .messages.flatMap((message) => message.content)
  .find((content) => content.type === 'actionRequired');
if (!action || action.type !== 'actionRequired' || action.data.actionType !== 'toolConfirmation')
  throw Error('Missing approval card');
const data = { ...action.data, sessionId: request.sessionId };
void loadMessages('zh-CN').then((messages) =>
  createRoot(document.getElementById('root')!).render(
    <IntlProvider locale="zh-CN" messages={messages}>
      <main style={{ padding: 24, color: 'var(--color-text-primary)' }}>
        <article
          style={{ border: '1px solid var(--color-border-primary)', padding: 16, borderRadius: 12 }}
        >
          <p>{labels[toolName] ?? toolName} · 等待确认</p>
          <ToolApprovalButtons data={data} />
        </article>
        <output id="reply" style={{ overflowWrap: 'anywhere' }} />
      </main>
    </IntlProvider>
  )
);
