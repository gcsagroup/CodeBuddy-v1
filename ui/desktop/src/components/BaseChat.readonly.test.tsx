import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import BaseChat from './BaseChat';

const fixture = vi.hoisted(() => ({ readonly: true, submit: vi.fn(), update: vi.fn() }));
vi.mock('../hooks/useChatSession', () => ({
  useChatSession: () => ({
    session: {
      id: 'imported',
      name: 'Saved history',
      session_type: 'code_pro',
      extension_data: { readonlyHistory: fixture.readonly },
    },
    messages: [
      {
        id: 'saved',
        role: 'assistant',
        content: [{ type: 'text', text: 'Saved answer' }],
        metadata: { userVisible: true, agentVisible: true },
      },
    ],
    chatState: 'idle',
    tokenState: {},
    notifications: new Map(),
    handleSubmit: fixture.submit,
    onMessageUpdate: fixture.update,
  }),
}));
vi.mock('../acp/acpConnection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../acp/acpConnection')>()),
  isAcpRecovering: () => false,
  subscribeToAcpRecovery: () => () => {},
}));
vi.mock('./ChatInput', () => ({ default: () => <textarea aria-label="Compose message" /> }));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('./codepro/CodeProPlanDock', () => ({ CodeProPlanDock: () => null }));
vi.mock('./ProgressiveMessageList', () => ({
  default: ({
    onMessageUpdate,
    resubmitMessage,
  }: {
    onMessageUpdate?: unknown;
    resubmitMessage?: unknown;
  }) => (
    <div>
      Saved answer{onMessageUpdate ? <button>Edit or retry</button> : null}
      {resubmitMessage ? <button>Resume task</button> : null}
    </div>
  ),
}));

beforeEach(() => {
  fixture.readonly = true;
  fixture.submit.mockReset();
  fixture.update.mockReset();
  Object.assign(window.electron, { logInfo: vi.fn() });
});

function show() {
  return render(
    <MemoryRouter initialEntries={['/codepro?resumeSessionId=imported&shouldStartAgent=true']}>
      <BaseChat
        sessionId="imported"
        isActiveSession
        suppressEmptyState
        setChat={vi.fn()}
        initialMessage={{ msg: 'old continuation', images: [] }}
      />
    </MemoryRouter>,
    { wrapper: IntlTestWrapper }
  );
}

it('shows archived content without composing, editing, retrying or auto-submitting old continuation', async () => {
  show();
  expect(screen.getByText('Saved answer')).toBeVisible();
  expect(
    screen.getByText('Imported history is read-only. Start a new task to continue working.')
  ).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit or retry' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resume task' })).toBeNull();
  await waitFor(() => expect(fixture.submit).not.toHaveBeenCalled());
});

it('retains normal conversation controls outside imported history', () => {
  fixture.readonly = false;
  show();
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit or retry' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Resume task' })).toBeVisible();
});
