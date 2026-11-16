import type { ContentBlock, PromptResponse } from '@agentclientprotocol/sdk';
import type { SteerSessionRequest_unstable, SteerSessionResponse_unstable } from '@aaif/goose-sdk';
import type { Message } from '../types/message';
import { getAcpClient } from './acpConnection';
import { currentLocale } from '../i18n';

// Stable ACP wire identifiers preserve compatibility with existing backends.
export const CODEPRO_TURN_RETRY_META_KEY = 'codeagentpro/turn-retry';
export const CODEPRO_SOURCE_MESSAGE_ID_META_KEY = 'codeagentpro/source-message-id';
export const CODEPRO_CHECKPOINT_CONTEXT_META_KEY = 'codeagentpro/checkpoint-context';

export interface CodeProCheckpointContext {
  schemaVersion: 1;
  checkpointId: string;
  sourceRunId: string;
  sourceUserMessageId: string;
  sourceTerminalMessageId: string;
}

interface CodeProTurnRetryMetadataBase {
  schemaVersion: 1;
  sourceRunId: string;
  sourceUserMessageId: string;
}

export type CodeProTurnRetryMetadata = CodeProTurnRetryMetadataBase &
  (
    | { strategy: 'continue_checkpoint'; checkpointId: string }
    | { strategy: 'resume_after_workspace'; checkpointId: null }
    | { strategy: 'replay_user_request'; checkpointId: null }
    | {
        strategy: 'retry_failed_validation';
        checkpointId: null;
        sourceTerminalMessageId: string;
      }
  );

export async function acpPromptSession(
  sessionId: string,
  message: Message,
  turnRetry?: CodeProTurnRetryMetadata,
  checkpointContext?: CodeProCheckpointContext
): Promise<PromptResponse> {
  if (!await window.electron.requestNetworkAccess()) return { stopReason: 'cancelled' };
  const client = await getAcpClient();
  const meta = {
    'codebuddy/client-locale': currentLocale,
    ...(message.metadata.queuedWhileBusy === true && !turnRetry
      ? { 'codebuddy/input-origin': 'queued-while-busy' }
      : {}),
    ...(message.metadata.desktopGeneration !== undefined
      ? { 'codebuddy/desktop-generation': message.metadata.desktopGeneration }
      : {}),
    ...(message.metadata.planMode !== undefined
      ? { 'codebuddy/plan': message.metadata.planMode }
      : {}),
    ...(message.metadata.goalRequest ? { 'codebuddy/goal': message.metadata.goalRequest } : {}),
    ...(message.id ? { [CODEPRO_SOURCE_MESSAGE_ID_META_KEY]: message.id } : {}),
    ...(message.metadata.resumedRequestId ? { 'codebuddy/resumed-request-id': message.metadata.resumedRequestId } : {}),
    ...(message.metadata.presentation
      ? { 'codebuddy/message-presentation': message.metadata.presentation }
      : {}),
    ...(turnRetry ? { [CODEPRO_TURN_RETRY_META_KEY]: turnRetry } : {}),
    ...(checkpointContext ? { [CODEPRO_CHECKPOINT_CONTEXT_META_KEY]: checkpointContext } : {}),
  };
  return client.prompt({
    sessionId,
    prompt: messageToAcpPromptContent(message),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  });
}

export async function acpCancelPrompt(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.cancel({ sessionId });
}

export async function acpSteerSession(
  sessionId: string,
  message: Message,
  expectedRunId: string
): Promise<SteerSessionResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.sessionSteer_unstable({
    sessionId,
    expectedRunId,
    prompt: messageToAcpPromptContent(message) as unknown as SteerSessionRequest_unstable['prompt'],
    ...(message.metadata.queuedWhileBusy === true
      ? { _meta: { 'codebuddy/input-origin': 'queued-while-busy' } }
      : {}),
  });
}

export function messageToAcpPromptContent(message: Message): ContentBlock[] {
  const prompt: ContentBlock[] = [];

  for (const content of message.content) {
    switch (content.type) {
      case 'text':
        if (content.text.trim()) {
          prompt.push({
            type: 'text',
            text: content.text,
          });
        }
        break;
      case 'image':
        prompt.push({
          type: 'image',
          data: content.data,
          mimeType: content.mimeType,
        });
        break;
    }
  }

  return prompt;
}
