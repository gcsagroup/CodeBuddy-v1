import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import MarkdownContent from '../../src/components/MarkdownContent';
import { WorkspacePanelContent } from '../../src/workspace-panel/WorkspacePanel';
import '../../src/styles/main.css';
import '../../src/workspace-panel/workspacePanel.css';

const scope = { sessionId: 'manual-source', root: new URLSearchParams(location.search).get('root')! };
function Fixture() {
  const [expanded, setExpanded] = useState(false);
  return <IntlProvider locale="en" messages={{}}>
    <div style={{ display: 'flex', height: '100vh' }}>
      <main style={{ flex: 1 }}>
        <MarkdownContent content={`[Repository README](${location.origin}/slow-source)`} sessionId={scope.sessionId} />
      </main>
      <WorkspacePanelContent scope={scope} expanded={expanded} width={500} onExpandedChange={setExpanded} />
    </div>
  </IntlProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
