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
import ProgressiveMessageList from '../../src/components/ProgressiveMessageList';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

function HistoryFixture() {
  const area = useRef<ScrollAreaHandle>(null);
  const messages: Message[] = Array.from({ length: 48 }, (_, index) => [
    {
      id: `history-user-${index}`,
      role: 'user' as const,
      created: index * 10,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'text' as const, text: `History question ${index}` }],
    },
    {
      id: `history-answer-${index}`,
      role: 'assistant' as const,
      created: index * 10 + 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [
        {
          type: 'text' as const,
          text: Array.from(
            { length: 12 },
            (_, line) =>
              `History answer ${index} paragraph ${line}. Reading position must remain continuous.`
          ).join('\n\n'),
        },
      ],
    },
  ]).flat();
  return (
    <IntlTestWrapper>
      <MemoryRouter>
        <main style={{ width: 800, padding: 24 }}>
          <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
          <ScrollArea ref={area} autoScroll style={{ height: 520 }}>
            <ProgressiveMessageList
              messages={messages}
              chat={{ sessionId: 'history-regression' }}
              readOnly
              maxVisibleMessages={8}
              batchSize={8}
              isUserMessage={(item) => item.role === 'user'}
            />
          </ScrollArea>
        </main>
      </MemoryRouter>
    </IntlTestWrapper>
  );
}

function AutoFoldFixture() {
  const area = useRef<ScrollAreaHandle>(null);
  const [running, setRunning] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [following, setFollowing] = useState(true);
  const turnGroup = new URLSearchParams(window.location.search).has('turn-group');
  const thoughts = [0, 1, 2].map((id) => (
    <ThinkingContent
      key={id}
      isExpanded={running}
      content={Array.from({ length: 30 }, (_, n) => `Reasoning ${id}-${n}\n\n`).join('')}
    />
  ));
  return (
    <IntlTestWrapper>
      <main style={{ padding: 24, width: 850 }}>
        <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
        <button onClick={() => setRunning(false)}>Finish run</button>
        <button onClick={() => setHidden(true)}>Remove work</button>
        <span role="status">{following ? 'Following output' : 'Reading history'}</span>
        <ScrollArea ref={area} autoScroll onScrollChange={setFollowing} style={{ height: 520 }}>
          <div style={{ height: 900 }}>Earlier conversation</div>
          {!hidden &&
            (turnGroup ? (
              <ToolCallExpandable
                compact
                label="Turn work"
                scrollable={false}
                collapsible={!running}
                collapseOnSettle={!running}
              >
                {thoughts}
              </ToolCallExpandable>
            ) : (
              thoughts
            ))}
          <p>Final verified result</p>
        </ScrollArea>
      </main>
    </IntlTestWrapper>
  );
}

function ThoughtReadingFixture() {
  const grouped = new URLSearchParams(window.location.search).has('grouped');
  const edgeList = new URLSearchParams(window.location.search).has('edge-list');
  const [extra, setExtra] = useState(false);
  const content =
    Array.from(
      { length: 80 },
      (_, index) =>
        `Reading paragraph ${index}. **Keep this passage** while folding, reopening and receiving new output.`
    ).join('\n\n') +
    '\n\n' +
    'LongUnbrokenToken'.repeat(100) +
    '\n\nhttps://example.com/' +
    'long-path-'.repeat(100) +
    '\n\n```text\n' +
    'const value = 123; '.repeat(80) +
    '\n```\n\n' +
    '| Column | Data |\n| --- | --- |\n| Value | ' +
    'WideTableCell'.repeat(80) +
    ' |';
  const thoughts = (
    <>
      <div className="goose-message">
        <div className="flex w-full min-w-0 flex-col">
          <ThinkingContent
            content={content + (extra ? '\n\nNew reasoning arrived.' : '')}
            isExpanded={false}
            storageKey="reading-first"
          />
        </div>
      </div>
      <ThinkingContent
        content="Second thought stays independent."
        isExpanded={false}
        storageKey="reading-second"
      />
      <div style={{ height: 240 }}>Tool receipts below reasoning</div>
    </>
  );
  const rows = edgeList
    ? Array.from({ length: 24 }, (_, index) =>
        index % 3 === 0 ? (
          <ThinkingContent
            key={index}
            content={`Reading record ${index}. Check the completed operations before continuing.`}
            isExpanded={false}
          />
        ) : (
          <ToolCallExpandable
            key={index}
            compact
            label={`Completed operation ${index}: inspect the local fixture`}
            icon={<ToolActivityIcon name="shell" status="success" />}
          >
            <p>Local operation receipt</p>
          </ToolCallExpandable>
        )
      )
    : thoughts;
  return (
    <IntlTestWrapper>
      <main className="codepro-conversation" style={{ padding: 24, width: 'min(850px, 100vw)' }}>
        <button onClick={() => setExtra(true)}>Append reasoning</button>
        <ScrollArea autoScroll className="codepro-chat-history" style={{ height: 520 }}>
          <p style={{ height: 160 }}>Earlier conversation</p>
          {grouped ? (
            <ToolCallExpandable compact groupHeading label="Thought work" isStartExpanded>
              {rows}
            </ToolCallExpandable>
          ) : (
            thoughts
          )}
          <p style={{ height: 160 }}>Final answer stays outside reasoning</p>
        </ScrollArea>
      </main>
    </IntlTestWrapper>
  );
}

function Fixture() {
  const area = useRef<ScrollAreaHandle>(null);
  const [lines, setLines] = useState(0);
  const [following, setFollowing] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [height, setHeight] = useState(520);
  const [earlierHeight, setEarlierHeight] = useState(900);
  return (
    <main style={{ padding: 24, width: 850 }}>
      <div style={{ display: 'flex', gap: 16, height: 60, alignItems: 'center', marginBottom: 12 }}>
        <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
        <button onClick={() => setLines((value) => value + 1)}>Append output</button>
        <button onClick={() => setLines((value) => value + 8)}>Append burst</button>
        <button onClick={() => setEarlierHeight((value) => value + 420)}>
          Grow earlier content
        </button>
        <button onClick={() => setHeight((value) => (value === 520 ? 300 : 520))}>
          Resize viewport
        </button>
        <span role="status">{following ? 'Following output' : 'Reading history'}</span>
        {!atBottom && (
          <button onClick={() => area.current?.scrollToBottom()}>Return to latest</button>
        )}
      </div>
      <ScrollArea
        ref={area}
        autoScroll
        onScrollChange={setFollowing}
        onBottomChange={setAtBottom}
        style={{ height, border: '1px solid gray' }}
      >
        <div style={{ padding: '0 24px' }}>
          <div style={{ height: earlierHeight }}>Earlier conversation</div>
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
          <div data-turn-process-summary="">
            <ToolCallExpandable
              compact
              groupHeading
              scrollable={false}
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
          </div>
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
if (query.has('thinking-reading') || query.has('presentation')) {
  const theme = query.has('dark') ? 'dark' : 'light';
  applyThemeTokens(theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.classList.toggle('light', theme === 'light');
  document.documentElement.style.colorScheme = theme;
}
createRoot(document.getElementById('root')!).render(
  query.has('history') ? (
    <HistoryFixture />
  ) : query.has('thinking-reading') ? (
    <ThoughtReadingFixture />
  ) : query.has('auto-fold') ? (
    <AutoFoldFixture />
  ) : query.has('file-card') ? (
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
