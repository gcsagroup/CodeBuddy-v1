import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScrollArea, type ScrollAreaHandle } from '../../src/components/ui/scroll-area';
import { ToolCallExpandable } from '../../src/components/ToolCallExpandable';
import { CodeProActivityTimeline } from '../../src/components/codepro/CodeProActivity';
import type { CodeProActivityViewModel } from '../../src/components/codepro/codeProActivityModel';
import { TechnicalValue } from '../../src/components/TechnicalValue';
import ThinkingContent from '../../src/components/ThinkingContent';
import { ToolActivityIcon } from '../../src/components/ToolActivityIcon';
import MarkdownContent from '../../src/components/MarkdownContent';
import '../../src/components/conversation-presentation.css';
import '../../src/workspace-panel/workspacePanel.css';
import { WorkspacePanelContent } from '../../src/workspace-panel/WorkspacePanel';
import { CodeProConversationFiles } from '../../src/components/codepro/CodeProConversationFiles';
import type { Message } from '../../src/types/message';
import { CodeProFileViewer } from '../../src/components/codepro/CodeProFileViewer';
import { CodeProPlan } from '../../src/components/codepro/CodeProToolContent';
import { IntlTestWrapper } from '../../src/i18n/test-utils';
import { NavigationSidebar } from '../../src/components/Layout/NavigationSidebar';
import {
  NavigationChatsSection,
  NavigationHeaderSlot,
  ProjectSessionGroup,
  SessionRow,
} from '../../src/components/Layout/NavigationPanel';
import type { ProjectGroup } from '../../src/utils/projectSessions';
import { MemoryRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { toastService } from '../../src/toasts';
import { showExtensionLoadResults } from '../../src/utils/extensionErrorUtils';

function Fixture() {
  const area = useRef<ScrollAreaHandle>(null);
  const [lines, setLines] = useState(0);
  return (
    <main style={{ padding: 24, width: 850 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
        <button onClick={() => setLines((value) => value + 1)}>Append output</button>
      </div>
      <ScrollArea ref={area} autoScroll style={{ height: 520, border: '1px solid gray' }}>
        <div style={{ padding: '0 24px' }}>
          <div style={{ height: 900 }}>Earlier conversation</div>
          <ToolCallExpandable compact label="Work history" isStartExpanded>
            <div style={{ height: 260 }}>Tool receipts</div>
          </ToolCallExpandable>
          <p style={{ margin: '24px 0' }}>Execution has ended. Results retained.</p>
          <details
            className="codepro-disclosure"
            open
            style={{ padding: 12, border: '1px solid gray' }}
          >
            <summary>View changed files</summary>
            <div style={{ height: 440, paddingTop: 16 }}>
              booking_app.py
              <details style={{ marginTop: 16 }}>
                <summary>Per-operation changes</summary>
                <div style={{ height: 100 }}>Change receipt</div>
              </details>
            </div>
          </details>
          {Array.from({ length: lines }, (_, i) => (
            <p key={i} style={{ height: 100 }}>
              New output {i + 1}
            </p>
          ))}
          <div style={{ height: 32 }} />
        </div>
      </ScrollArea>
    </main>
  );
}

const activities: CodeProActivityViewModel[] = ['README.md', 'appointments.csv'].map((path) => ({
  key: path,
  source: 'activity_event',
  runId: 'fixture',
  eventId: path,
  taskId: null,
  eventType: 'file_read',
  state: 'completed',
  statusLabel: 'Completed',
  verb: 'Read',
  target: path,
  summary: path,
  title: 'File read',
  toolName: 'developer__read',
  path,
  command: null,
  duration: '1s',
  exitCode: null,
  parameters: [],
  output: Array.from({ length: 15 }, (_, i) => `Receipt line ${i + 1}`).join('\n'),
  diffSummary: null,
  effectiveModel: null,
  failureKind: null,
  riskTier: null,
  previousRiskTier: null,
  flow: null,
  reviewRequired: null,
  riskReasons: [],
  testProgress: null,
  structured: true,
}));

function ActivityFixture() {
  const area = useRef<ScrollAreaHandle>(null);
  return (
    <IntlTestWrapper>
      <main style={{ padding: 24, width: 850 }}>
        <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
        <ScrollArea ref={area} autoScroll style={{ height: 520 }}>
          <div style={{ height: 900 }}>Earlier conversation</div>
          <CodeProActivityTimeline
            items={activities.map((activity) => ({
              kind: 'activity',
              key: activity.key,
              activity,
            }))}
          />
          <TechnicalValue label="Long output" value={activities[0].output!} />
          <CodeProPlan requestId="fixture-plan" compact content={'[ ] First step\n[ ] Second step'}>
            Plan body
          </CodeProPlan>
          <div style={{ height: 32 }} />
        </ScrollArea>
      </main>
    </IntlTestWrapper>
  );
}

function SidebarFixture() {
  const [expanded, setExpanded] = useState(true);
  const group: ProjectGroup = {
    label: 'timeout',
    path: 'C:/fixture/timeout',
    lastActivityAt: '2026-10-09',
    sessions: Array.from({ length: 5 }, (_, i) => ({
      id: `fixture-${i}`,
      name: `Chat ${i + 1}`,
      workingDir: 'C:/fixture/timeout',
      updatedAt: '2026-10-09',
      createdAt: '2026-10-09',
      messageCount: 0,
    })),
  };
  return (
    <IntlTestWrapper>
      <button onClick={() => setExpanded(!expanded)}>Toggle sidebar</button>
      <div style={{ display: 'flex', height: 600 }}>
        <NavigationSidebar expanded={expanded} onExpandedChange={setExpanded}>
          <div className="flex h-full min-h-0 flex-col">
            <NavigationHeaderSlot
              workspaceMode="codepro"
              onWorkspaceModeChange={() => {}}
              unifiedMode
              onNewChat={() => {}}
            />
            <NavigationChatsSection>
              <ProjectSessionGroup
                group={group}
                renderSession={(session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === 'fixture-0'}
                    status={undefined}
                    onClick={() => {}}
                    onRenamed={() => {}}
                  />
                )}
              />
            </NavigationChatsSection>
            <div style={{ height: 40 }}>Settings</div>
          </div>
        </NavigationSidebar>
        <div style={{ flex: 1, minWidth: 0 }} data-testid="chat-canvas">
          Chat canvas
        </div>
      </div>
    </IntlTestWrapper>
  );
}

function FileCardFixture() {
  const area = useRef<ScrollAreaHandle>(null);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const sessionId = 'file-card-session';
  const messages: Message[] = ['app.py', 'test.py', 'app.py'].map((path, index) => ({
    id: `file-${index}`,
    role: 'assistant',
    created: 0,
    metadata: { userVisible: true, agentVisible: true },
    content: [
      {
        type: 'toolResponse',
        id: `edit-${index}`,
        toolResult: {
          status: 'success',
          value: {
            content: [],
            structuredContent: {
              file_change: {
                schema_version: 1,
                path,
                added: 30,
                removed: 30,
                diff_truncated: false,
                diff:
                  '@@ -7,30 +7,30 @@\n' +
                  Array.from({ length: 30 }, (_, i) => `-before ${i}\n+after ${i}`).join('\n'),
              },
            },
          },
        },
        metadata: {
          toolAudit: {
            schemaVersion: 1,
            auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
            actor: 'primary',
            effectiveModel: 'unknown',
            extensionSource: 'platform',
            toolName: 'developer::edit',
            permissionClass: 'workspace_write',
            authorization: 'policy_allowed',
            outcome: 'success',
            taskScoped: true,
            startedAt: '2026-10-09T06:00:00Z',
            completedAt: '2026-10-09T06:00:01Z',
            durationMs: 1000,
          },
        },
      },
    ],
  }));
  const sourceMessages: Message[] = [
    {
      id: 'file-card-user',
      role: 'user',
      created: 0,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'text', text: 'Update the fixture files' }],
    },
    ...messages,
  ];
  return (
    <IntlTestWrapper>
      <main
        className="codepro-conversation"
        style={{ position: 'relative', padding: 24, paddingRight: 484, width: 1000, height: 620 }}
      >
        <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
        <ScrollArea ref={area} autoScroll style={{ height: 520 }}>
          <div className="codepro-chat-history" style={{ padding: '0 24px' }}>
            <div style={{ height: 900 }}>Earlier conversation</div>
            <CodeProConversationFiles
              messages={sourceMessages}
              sourceMessages={sourceMessages}
              sessionId={sessionId}
              workspaceRoot="C:/fixture"
            />
            <div style={{ height: 32 }} />
          </div>
        </ScrollArea>
        <WorkspacePanelContent
          scope={{ sessionId, root: 'C:/fixture' }}
          messages={sourceMessages}
          expanded={panelExpanded}
          onExpandedChange={setPanelExpanded}
          width={440}
          layout="overlay"
        />
      </main>
    </IntlTestWrapper>
  );
}

function PresentationFixture({ subagent = false }: { subagent?: boolean }) {
  return (
    <IntlTestWrapper>
      <main
        className={subagent ? 'workspace-panel codepro-conversation' : 'codepro-conversation'}
        style={{ padding: 24, width: 760 }}
      >
        <div className="codepro-chat-history">
          <MarkdownContent
            className="codepro-assistant-prose"
            content={
              '收到需求，开始处理。\n\n## 实现结果\n\n保持原有功能。\n\n- 保留列表、**重点**和[链接](https://example.com)。\n\n`inline_code`\n\n```text\nconst value = 1;\n```'
            }
          />
          <CodeProFileViewer
            files={['change.py']}
            changesForFile={() => [
              {
                path: 'change.py',
                added: 1,
                removed: 1,
                diff: '@@ -7 +7 @@\n-before\n+after',
                diff_truncated: false,
              },
            ]}
          />
          <CodeProPlan requestId="presentation-plan" compact content="- [ ] 保持原有功能">
            <p>任务要求内容</p>
          </CodeProPlan>
          <ThinkingContent content="思考内容" isExpanded={false} />
          <ToolCallExpandable
            compact
            label="用时 1分钟 10秒"
            contentClassName="text-text-secondary"
          >
            <MarkdownContent content="处理记录" className="codepro-assistant-prose" />
            <p className="text-text-secondary">操作说明</p>
            <ToolCallExpandable
              compact
              icon={<ToolActivityIcon name="developer__read" status="success" />}
              label="已查看文件 smoke_test_app.py"
            >
              <p>文件内容</p>
            </ToolCallExpandable>
            <CodeProActivityTimeline
              items={activities.map((activity) => ({
                kind: 'activity',
                key: activity.key,
                activity,
              }))}
            />
          </ToolCallExpandable>
          <ToolCallExpandable
            compact
            icon={<ToolActivityIcon name="developer__tree" status="success" />}
            label="列出文件"
          >
            <details className="codepro-disclosure rounded-md bg-background-secondary">
              <summary>诊断记录</summary>
              <p>原始回执</p>
            </details>
          </ToolCallExpandable>
        </div>
      </main>
    </IntlTestWrapper>
  );
}

function ToastFixture() {
  return (
    <IntlTestWrapper>
      <MemoryRouter>
        <button
          onClick={() =>
            toastService.extensionLoading([{ name: 'developer', status: 'loading' }], 1, false)
          }
        >
          Start extensions
        </button>
        <button onClick={() => showExtensionLoadResults([{ name: 'developer', success: true }])}>
          Finish extensions
        </button>
        <button
          onClick={() =>
            showExtensionLoadResults([
              { name: 'example', success: false, error: 'Example connection failed' },
            ])
          }
        >
          Fail extension
        </button>
        <ToastContainer pauseOnHover pauseOnFocusLoss closeOnClick />
      </MemoryRouter>
    </IntlTestWrapper>
  );
}

const query = new URLSearchParams(window.location.search);
createRoot(document.getElementById('root')!).render(
  query.has('file-card') ? (
    <FileCardFixture />
  ) : query.has('presentation') ? (
    <PresentationFixture subagent={query.has('subagent')} />
  ) : query.has('toast') ? (
    <ToastFixture />
  ) : query.has('sidebar') ? (
    <SidebarFixture />
  ) : query.has('activity') ? (
    <ActivityFixture />
  ) : (
    <Fixture />
  )
);
