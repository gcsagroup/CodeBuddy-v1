import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceGeneration, type MediaJob } from '../../src/workspace-panel/WorkspaceGeneration';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';

const scope = { sessionId: 'fixture', root: 'D:/fixture' };
const params = new URLSearchParams(location.search);
applyThemeTokens(params.has('dark') ? 'dark' : 'light');
// A small local media fixture exercises the actual browser player without a GPU job.
const videoFixture = params.has('video')
  ? new Promise<string>((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 100;
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
      };
      recorder.start();
      const context = canvas.getContext('2d')!;
      const timer = setInterval(() => {
        context.fillStyle = 'seagreen';
        context.fillRect(0, 0, 100, 100);
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        recorder.stop();
      }, 1000);
    })
  : Promise.resolve('');
window.electron = {
  workspacePanel: async ({ path }: { path: string }) => ({
    document: {
      media: path.endsWith('.mp4')
        ? { kind: 'video', mimeType: 'video/webm', url: await videoFixture }
        : {
            kind: 'image',
            mimeType: 'image/svg+xml',
            url:
              'data:image/svg+xml,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="seagreen"/></svg>'
              ),
          },
    },
  }),
} as unknown as Window['electron'];

function Fixture() {
  const [state, setState] = useState('running');
  const job: MediaJob = {
    job_id: 'fixture',
    kind: params.has('video') ? 'video' : 'image',
    created_at: new Date(Date.now() - 23000).toISOString(),
    status: state,
    workflow: { id: 'fixture', label: '生成任务' },
    live:
      state === 'queued'
        ? { connected: true }
        : {
            connected: true,
            stage: 'sample',
            step: 11,
            total: 18,
            ...{ preview: 'data:image/png;base64,legacy-preview-must-not-load' },
          },
    images: [{ path: 'result.png' }],
    videos: params.has('video') ? [{ path: 'result.mp4' }] : undefined,
    error: state === 'failed' ? '生成失败，请重试。' : undefined,
  };
  return (
    <main
      style={{
        width: '100%',
        maxWidth: 420,
        color: 'var(--color-text-primary)',
        background: 'var(--color-background-primary)',
      }}
    >
      <nav>
        {['running', 'queued', 'completed', 'failed', 'cancelled'].map((value) => (
          <button key={value} onClick={() => setState(value)} style={{ padding: 6 }}>
            {value}
          </button>
        ))}
      </nav>
      <WorkspaceGeneration jobs={[job]} scope={scope} disconnected={false} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="zh-CN">
    <Fixture />
  </IntlProvider>
);
