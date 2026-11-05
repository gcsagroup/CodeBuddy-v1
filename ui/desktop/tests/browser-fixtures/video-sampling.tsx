import React from 'react';
import { createRoot } from 'react-dom/client';
import { useFileDrop } from '../../src/hooks/useFileDrop';
import { videoEvidenceContext, videoTimestamp } from '../../src/utils/videoEvidence';

window.electron = {
  getPathForFile: (file: File) => '/fixture/' + file.name,
} as typeof window.electron;
function App() {
  const { droppedFiles, addFiles } = useFileDrop();
  return (
    <main>
      <h1>Video sampling</h1>
      <input
        type="file"
        aria-label="Video"
        onChange={(event) => {
          if (event.target.files) void addFiles(event.target.files);
        }}
      />
      {droppedFiles.map((file) => (
        <section key={file.id}>
          <h2>{file.name}</h2>
          {file.isLoading && <p>Processing</p>}
          {file.error && <p role="alert">{file.error}</p>}
          {file.frameDataUrls?.map((url, index) => (
            <figure key={index} style={{ display: 'inline-block' }}>
              <img src={url} width="160" alt={'Frame ' + (index + 1)} />
              <figcaption>{videoTimestamp(file.videoSample!.timestampsSeconds[index])}</figcaption>
            </figure>
          ))}
        </section>
      ))}
      <pre data-testid="evidence">{videoEvidenceContext(droppedFiles, 0)}</pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
