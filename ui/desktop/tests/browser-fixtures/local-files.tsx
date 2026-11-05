import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { WorkspacePanelContent } from '../../src/workspace-panel/WorkspacePanel';
import type { PanelRequest } from '../../src/workspace-panel/workspacePanelTypes';
import '../../src/styles/main.css';
import '../../src/styles/desktop-shell.css';
import '../../src/workspace-panel/workspacePanel.css';

Object.assign(window, {
  electron: {
    platform: 'win32',
    on: () => {},
    off: () => {},
    getSetting: async () => false,
    workspacePanel: async (request: PanelRequest) => {
      if (request.action === 'open-target') {
        document.documentElement.dataset.openReceipt = JSON.stringify(request);
        return {};
      }
      return request.action === 'list'
        ? { entries: [{ name: '中文测试文件.txt', path: '中文测试文件.txt', kind: 'file' }] }
        : {
            document: {
              path: '中文测试文件.txt',
              content: 'FILE-PREVIEW-OK\n中文内容显示正常',
              version: '1',
            },
          };
    },
  },
});
function Fixture() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return (
    <IntlProvider locale="en" messages={{}}>
      <div className="desktop-shell h-screen relative flex">
        <button
          aria-label="Expand navigation"
          style={{ position: 'absolute', left: 12, top: 8, width: 28, height: 28, zIndex: 30 }}
        >
          ☰
        </button>
        <div
          className="shell-work-area relative flex flex-col flex-1 min-w-0 min-h-0"
          data-navigation-overlay="true"
        >
          <div className="shell-work-canvas relative flex-1 min-h-0">
            <WorkspacePanelContent
              scope={{ sessionId: 'toolbar-fixture', root: 'C:/preview' }}
              expanded
              width={width}
              onExpandedChange={() => {}}
            />
          </div>
        </div>
      </div>
    </IntlProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
