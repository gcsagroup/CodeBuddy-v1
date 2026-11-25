import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceInputStatus } from './VoiceInputStatus';

vi.mock('../i18n', () => ({ currentLocale: 'zh-CN' }));

describe('voice input feedback', () => {
  it('offers retry and dismissal for silence without a transcribing spinner', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<VoiceInputStatus recording={false} transcribing={false} notice="no-speech" onRetry={onRetry} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent('未检测到清晰语音');
    expect(screen.queryByText('正在识别语音…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭语音提示' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('distinguishes empty recognition from silence and replaces the notice during capture', () => {
    const { rerender } = render(<VoiceInputStatus recording={false} transcribing={false} notice="empty-transcript" />);
    expect(screen.getByRole('status')).toHaveTextContent('未识别到文字');
    rerender(<VoiceInputStatus recording transcribing={false} notice="empty-transcript" />);
    expect(screen.getByRole('status')).toHaveTextContent('正在录音');
    expect(screen.queryByText(/未识别到文字/)).not.toBeInTheDocument();
  });
});
