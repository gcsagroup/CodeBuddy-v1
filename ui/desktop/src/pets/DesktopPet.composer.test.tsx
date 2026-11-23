vi.mock('../hooks/useAudioRecorder', () => ({
  useAudioRecorder: () => ({ isRecording: false, isTranscribing: false, startRecording: async () => {}, stopRecording: () => {} }),
}));
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DesktopPet from './DesktopPet';
import type { PetSnapshot } from './petTypes';

vi.mock('../i18n', () => ({ currentLocale: 'zh-CN' }));
vi.mock('./PetSprite', () => ({ PetSprite: () => <div>pet sprite</div> }));
vi.mock('../utils/conversionUtils', () => ({
  compressImageDataUrl: vi.fn(async () => 'data:image/jpeg;base64,eA=='),
}));
const snapshot = {
  preferences: { visible: true, selectedId: 'red-panda', size: 160, reducedMotion: false },
  pets: [{ id: 'red-panda', fps: 6 }],
  task: null,
  tasks: [],
  errors: [],
  creationDirectory: '/pets',
} as unknown as PetSnapshot;
afterEach(() => vi.useRealTimers());
async function setup(open = true) {
  const desktopPet = vi.fn().mockResolvedValue(snapshot);
  Object.assign(window.electron, { desktopPet, petSignal: vi.fn(), on: vi.fn(), off: vi.fn() });
  render(<DesktopPet />);
  const pet = await screen.findByRole('button', { name: '点击宠物发消息' });
  if (open) {
    fireEvent.keyDown(pet, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '消息' })).toHaveFocus());
  }
  const input = screen.queryByRole('textbox', { name: '消息' })!;
  return { desktopPet, input, pet };
}
describe('pet message composer', () => {
  it('opens through accessibility activation without pointer events', async () => {
    const { pet } = await setup(false);
    fireEvent.click(pet, { detail: 0 });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
  });
  it('opens after a click but does not open when dragging or double-clicking', async () => {
    const { pet, desktopPet } = await setup(false);
    Object.assign(pet, { setPointerCapture: vi.fn() });
    vi.useFakeTimers();
    const pointer = (type: string, x: number) =>
      fireEvent(pet, new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: 50 }));
    pointer('pointerdown', 50);
    pointer('pointerup', 100);
    await act(async () => vi.advanceTimersByTime(350));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    pointer('pointerdown', 50);
    pointer('pointerup', 50);
    fireEvent.doubleClick(pet);
    await act(async () => vi.advanceTimersByTime(350));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    pointer('pointerdown', 50);
    pointer('pointerup', 50);
    await act(async () => vi.advanceTimersByTime(350));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(desktopPet).toHaveBeenCalledWith({ action: 'compose', composing: true });
  });
  it('sends once, keeps IME Enter and Shift+Enter for editing, and clears only after delivery', async () => {
    const { desktopPet, input } = await setup();
    fireEvent.change(input, { target: { value: '写一首诗🙂' } });
    desktopPet.mockClear();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(desktopPet).not.toHaveBeenCalled();
    let finish!: (value: PetSnapshot) => void;
    desktopPet.mockImplementation(
      () =>
        new Promise<PetSnapshot>((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(desktopPet).toHaveBeenCalledTimes(1);
    expect(desktopPet).toHaveBeenCalledWith({ action: 'send-message', message: '写一首诗🙂' });
    expect(input).toHaveValue('写一首诗🙂');
    await act(async () => finish(snapshot));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('keeps a failed draft and allows retry; empty drafts cannot be submitted', async () => {
    const { desktopPet, input } = await setup();
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '按住说话' })).toBeEnabled();
    fireEvent.change(input, { target: { value: '保留我的消息' } });
    desktopPet.mockRejectedValueOnce(new Error('delivery failed'));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留');
    expect(input).toHaveValue('保留我的消息');
    desktopPet.mockResolvedValue(snapshot);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });
  it('closing keeps the unsent draft and releases keyboard focus', async () => {
    const { desktopPet, input, pet } = await setup();
    fireEvent.change(input, { target: { value: '稍后发送' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(desktopPet).toHaveBeenCalledWith({ action: 'compose', composing: false });
    fireEvent.keyDown(pet, { key: 'Enter' });
    expect(await screen.findByRole('textbox')).toHaveValue('稍后发送');
  });
  it('attaches an image and a file, supports removing and sends their native chat payload', async () => {
    const { desktopPet, input } = await setup();
    window.electron.getPathForFile = vi.fn(() => 'C:\\test\\说明.txt');
    const picker = screen.getByLabelText('选择附件');
    fireEvent.change(picker, {
      target: {
        files: [
          new File(['x'], '照片.png', { type: 'image/png' }),
          new File(['notes'], '说明.txt', { type: 'text/plain' }),
        ],
      },
    });
    await waitFor(() => expect(screen.getByLabelText('移除 照片.png')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText('移除 说明.txt'));
    expect(screen.queryByText('说明.txt')).not.toBeInTheDocument();
    fireEvent.change(picker, {
      target: { files: [new File(['notes'], '说明.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByLabelText('移除 说明.txt')).toBeInTheDocument());
    fireEvent.change(input, { target: { value: '请看附件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(desktopPet).toHaveBeenCalledWith({
        action: 'send-message',
        message: '请看附件\n"C:\\\\test\\\\说明.txt"',
        images: [{ mimeType: 'image/jpeg', data: 'eA==' }],
      })
    );
  });
  it('keeps unreadable files visible and blocks submission until removed', async () => {
    await setup();
    window.electron.getPathForFile = vi.fn(() => '');
    fireEvent.change(screen.getByLabelText('选择附件'), {
      target: { files: [new File(['x'], '失效.txt')] },
    });
    expect(await screen.findByText(/读取失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('移除 失效.txt'));
    expect(screen.queryByText(/读取失败/)).not.toBeInTheDocument();
  });
  it('opens the context menu without sending a draft or opening another composer', async () => {
    const { desktopPet, input, pet } = await setup();
    fireEvent.change(input, { target: { value: '保留草稿' } });
    desktopPet.mockClear();
    fireEvent.contextMenu(pet);
    await waitFor(() => expect(desktopPet).toHaveBeenCalledWith({ action: 'context-menu' }));
    expect(desktopPet).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'send-message' })
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(pet, { detail: 0 });
    expect(await screen.findByRole('textbox')).toHaveValue('保留草稿');
  });
});
