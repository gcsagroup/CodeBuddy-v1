vi.mock('../hooks/useAudioRecorder', () => ({
  useAudioRecorder: () => ({ isRecording: false, isTranscribing: false, startRecording: async () => {}, stopRecording: () => {} }),
}));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IpcRendererEvent } from 'electron';
import { act, fireEvent, render, screen } from '@testing-library/react';
import DesktopPet from './DesktopPet';
import type { PetSnapshot } from './petTypes';

vi.mock('../i18n', () => ({ currentLocale: 'en' }));
vi.mock('./PetSprite', () => ({
  PetSprite: ({ animation }: { animation: string }) => <span role="img" aria-label={animation} />,
}));
const request = vi.fn();
const snapshot = {
  preferences: { visible: true, selectedId: 'red-panda', size: 160, reducedMotion: false },
  pets: [{ id: 'red-panda', fps: 6 }],
  task: null,
} as unknown as PetSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  request.mockReset().mockResolvedValue(snapshot);
  Object.assign(window, {
    electron: { desktopPet: request, petSignal: vi.fn(), on: vi.fn(), off: vi.fn() },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('approves a live tool request directly without navigating and shows the tool details', async () => {
  request.mockResolvedValue({ ...snapshot, task: { sessionId: 'approval', title: '新对话', state: 'input', inputRequest: { kind: 'permission', permission: { requestId: 'call', token: 'live', choices: [{ action: 'allow_once', label: '批准一次' }, { action: 'deny_once', label: '拒绝' }], details: 'write file: notes.md' } } } });
  await act(async () => { render(<DesktopPet />); });
  expect(screen.getByText('write file: notes.md')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '批准一次' })); });
  expect(request).toHaveBeenCalledWith({ action: 'resolve-permission', sessionId: 'approval', permission: { requestId: 'call', token: 'live', action: 'allow_once' } });
  expect(request.mock.calls.some(([input]) => input.action === 'open-task')).toBe(false);
});

it('plays a blocked reaction once, retains the badge, and rearms only on a new failure', async () => {
  const blocked = {
    sessionId: 'blocked',
    state: 'blocked',
    title: 'Failed chat',
    terminalId: 'failure-1',
  };
  request.mockResolvedValue({ ...snapshot, task: blocked });
  await act(async () => {
    render(<DesktopPet />);
  });
  const changed = vi
    .mocked(window.electron.on)
    .mock.calls.find(([event]) => event === 'pet-changed')![1];
  const publish = (task: typeof blocked) =>
    act(() => {
      changed({} as IpcRendererEvent, { ...snapshot, task });
    });
  expect(screen.getByRole('img', { name: 'failed' })).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(800);
  });
  publish({ ...blocked, title: 'Updated title' });
  act(() => {
    vi.advanceTimersByTime(1250);
  });
  expect(screen.getByRole('img', { name: 'idle' })).toBeInTheDocument();
  expect(screen.getByText('Blocked · click to view')).toBeInTheDocument();
  publish({ ...blocked });
  act(() => {
    vi.advanceTimersByTime(10000);
  });
  expect(screen.getByRole('img', { name: 'idle' })).toBeInTheDocument();
  publish({ ...blocked, state: 'working' });
  expect(screen.getByRole('img', { name: 'working' })).toBeInTheDocument();
  publish(blocked);
  expect(screen.getByRole('img', { name: 'failed' })).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(2050);
  });
  publish({ ...blocked, terminalId: 'failure-2' });
  expect(screen.getByRole('img', { name: 'failed' })).toBeInTheDocument();
});

it('observes a global cursor beyond 500 pixels even when an idle task remains', async () => {
  request.mockResolvedValue({
    ...snapshot,
    task: { sessionId: 'old', state: 'idle', title: 'Idle' },
  });
  await act(async () => {
    render(<DesktopPet />);
  });
  const callback = vi
    .mocked(window.electron.on)
    .mock.calls.find(([event]) => event === 'pet-cursor')?.[1];
  expect(callback).toBeDefined();
  act(() => {
    callback?.({} as IpcRendererEvent, { x: -1600, y: -800, reducedMotion: false });
  });
  expect(screen.getByRole('img', { name: 'look' })).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(1300);
  });
  expect(screen.getByRole('img', { name: 'idle' })).toBeInTheDocument();
});

it('waves for two full cycles after a click, then stays visible and returns to idle', async () => {
  await act(async () => {
    render(<DesktopPet />);
  });
  const sprite = screen.getByRole('img');
  fireEvent.pointerDown(sprite, { button: 0, screenX: 100, screenY: 100 });
  fireEvent.pointerUp(sprite, { button: 0, screenX: 100, screenY: 100 });
  expect(screen.getByRole('img', { name: 'wave' })).toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(1999);
  });
  expect(screen.getByRole('img', { name: 'wave' })).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(201);
  });
  expect(screen.getByRole('img', { name: 'idle' })).toBeInTheDocument();
  expect(request.mock.calls.map(([value]) => value.action)).toEqual([
    'get',
    'drag-start',
    'drag-end',
    'compose',
  ]);
});

it('does not open a task during a drag, and opens the composer on a stationary click', async () => {
  request.mockResolvedValue({
    ...snapshot,
    task: { state: 'completed', sessionId: 'fixture', title: 'Done' },
  });
  await act(async () => {
    render(<DesktopPet />);
  });
  const sprite = screen.getByRole('img');
  fireEvent.pointerDown(sprite, { button: 0, screenX: 100, screenY: 100 });
  fireEvent.pointerUp(sprite, { button: 0, screenX: 150, screenY: 100 });
  expect(request.mock.calls.some(([value]) => value.action === 'open-task')).toBe(false);
  fireEvent.pointerDown(sprite, { button: 0, screenX: 150, screenY: 100 });
  fireEvent.pointerUp(sprite, { button: 0, screenX: 150, screenY: 100 });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(request).toHaveBeenCalledWith({ action: 'compose', composing: true });
  expect(request.mock.calls.some(([value]) => value.action === 'open-task')).toBe(false);
  expect(screen.getByRole('img', { name: 'wave' })).toBeInTheDocument();
});

it('shows conversation identity, live action and completed check; list clicks open their own session without dragging', async () => {
  const tasks = [
    { sessionId: 'approval', title: 'Publish website', state: 'input' },
    {
      sessionId: 'build',
      title: 'Build desktop',
      state: 'working',
      activity: { kind: 'tool', toolName: 'pwsh', stage: 'Run regression tests' },
    },
    { sessionId: 'done', title: 'Draw rabbit', state: 'completed' },
  ];
  request.mockResolvedValue({ ...snapshot, task: tasks[0], tasks });
  await act(async () => {
    render(<DesktopPet />);
  });
  expect(screen.getByText('Publish website')).toBeInTheDocument();
  expect(screen.getByText('Build desktop')).toBeInTheDocument();
  const toggle = screen.getByRole('button', { name: /Conversations/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(toggle);
  expect(screen.queryByText('Build desktop')).not.toBeInTheDocument();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(screen.getByText('Run regression tests', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('Running tool · pwsh')).toBeInTheDocument();
  expect(screen.getByText('✓')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Build desktop/ }));
  expect(request).toHaveBeenCalledWith({ action: 'open-task', sessionId: 'build' });
  expect(request.mock.calls.some(([value]) => value.action === 'drag-start')).toBe(false);
  expect(screen.getByRole('img', { name: 'waiting' })).toBeInTheDocument();
});

it('shows question detail, preserves waiting on click, and pauses a running task through its owner', async () => {
  const question = {
    sessionId: 'q',
    title: 'Choose pet',
    state: 'input',
    inputRequest: { kind: 'question', summary: 'Which color?' },
  };
  const working = {
    sessionId: 'w',
    title: 'Render video',
    state: 'working',
    activity: { kind: 'tool', toolName: 'generate_video' },
  };
  request.mockResolvedValue({ ...snapshot, task: question, tasks: [question, working] });
  await act(async () => {
    render(<DesktopPet />);
  });
  expect(screen.getByText('Waiting for your reply')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Choose pet/ }));
  expect(screen.getByText('Which color?')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(request).toHaveBeenCalledWith({ action: 'pause-task', sessionId: 'w' });
});


it('opens local add actions immediately and hands a draft to main without submitting', async () => {
  await act(async () => { render(<DesktopPet />); });
  const sprite = screen.getByRole('img');
  fireEvent.pointerDown(sprite, { button: 0, screenX: 100, screenY: 100 });
  fireEvent.pointerUp(sprite, { button: 0, screenX: 100, screenY: 100 });
  await act(async () => { vi.advanceTimersByTime(300); });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep my draft' } });
  const before = request.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Add attachments or features' }));
  expect(screen.getByRole('button', { name: /^File$/ })).toBeVisible();
  expect(request.mock.calls).toHaveLength(before);
  expect(screen.getByRole('button', { name: /^Goal$/ })).toBeVisible();
  request.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skills and tools in main conversation' })); });
  expect(screen.getByRole('textbox')).toHaveValue('keep my draft');
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'open-composer', composerAction: 'add', message: 'keep my draft' }));
});
