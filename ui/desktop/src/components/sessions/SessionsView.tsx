import React, { useCallback } from 'react';
import SessionListView from './SessionListView';
import { useNavigation } from '../../hooks/useNavigation';
import { beginSessionLoadTiming } from '../../acp/sessionLoadTiming';
import { acpChatSessionController } from '../../acp/chatSessionController';

const SessionsView: React.FC = () => {
  const setView = useNavigation();

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      beginSessionLoadTiming(sessionId, 'history');
      void acpChatSessionController.loadSession(sessionId);
      setView('pair', {
        disableAnimation: true,
        resumeSessionId: sessionId,
      });
    },
    [setView]
  );

  return <SessionListView onSelectSession={handleSelectSession} workspaceMode="unified" />;
};

export default SessionsView;
