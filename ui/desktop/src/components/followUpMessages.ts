import { defineMessages } from '../i18n';

export const followUpMessages = defineMessages({
  title: { id: 'followUp.title', defaultMessage: 'Follow-up messages' },
  description: { id: 'followUp.description', defaultMessage: 'Queue messages for the next turn, or steer the current task. Ctrl+Enter uses the other mode.' },
  queue: { id: 'followUp.queue', defaultMessage: 'Queue' },
  steer: { id: 'followUp.steer', defaultMessage: 'Steer' },
  steerSend: { id: 'followUp.steerSend', defaultMessage: 'Steer the current task (Ctrl+Enter to queue)' },
  queuedSend: { id: 'followUp.queuedSend', defaultMessage: 'Queue for the next turn (Ctrl+Enter to steer)' },
  admitted: { id: 'followUp.admitted', defaultMessage: 'Received; waiting for the current task to process' },
  failed: { id: 'followUp.failed', defaultMessage: 'Could not save this preference. Please try again.' },
  loading: { id: 'followUp.loading', defaultMessage: 'Loading follow-up mode' },
  loadFailed: { id: 'followUp.loadFailed', defaultMessage: 'Could not read follow-up mode. Reopen chat settings and retry.' },
  retry: { id: 'followUp.retry', defaultMessage: 'Retry' },
  requeue: { id: 'followUp.requeue', defaultMessage: 'Not sent: queue this message instead' },
  unavailable: { id: 'followUp.unavailable', defaultMessage: 'This runtime does not support steering. Restart the updated preview, or queue this message instead.' },
  localPending: { id: 'followUp.localPending', defaultMessage: 'Unconfirmed local messages ({count})' },
  attachments: { id: 'followUp.attachments', defaultMessage: 'Attachments: {count}' },
});
