import React, { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import SessionListView from './SessionListView';
import { useNavigation } from '../../hooks/useNavigation';
import { isCodeProUnifiedModeEnabled } from '../../codepro/unifiedMode';
import { resolveSessionWorkspaceMode } from '../../acp/sessions';
import { beginSessionLoadTiming } from '../../acp/sessionLoadTiming';

const SessionsView: React.FC = () => {
  const setView = useNavigation();
  const location = useLocation();
  const workspaceMode = resolveSessionWorkspaceMode(
    location.pathname,
    isCodeProUnifiedModeEnabled(window.appConfig?.get?.('CODEPRO_UNIFIED_MODE'))
  );

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      beginSessionLoadTiming(sessionId, 'history');
      setView('pair', {
        disableAnimation: true,
        resumeSessionId: sessionId,
      });
    },
    [setView]
  );

  return <SessionListView onSelectSession={handleSelectSession} workspaceMode={workspaceMode} />;
};

export default SessionsView;
