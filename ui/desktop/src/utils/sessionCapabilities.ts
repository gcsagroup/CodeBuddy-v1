import type { SessionType } from '../types/session';
import { defineMessages } from '../i18n';

export function canForkSession(sessionType: SessionType | undefined): boolean {
  return sessionType !== undefined && sessionType !== 'code_pro';
}

export const sessionCapabilityMessages = defineMessages({
  forkUnavailable: {
    id: 'sessionCapabilities.forkUnavailable',
    defaultMessage:
      'Copying is unavailable for this session. Start a new task to work independently.',
  },
});
