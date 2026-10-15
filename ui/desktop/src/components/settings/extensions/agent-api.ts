import { toastService } from '../../../toasts';
import type { ExtensionConfig } from '../../../types/extensions';
import { addSessionExtension, removeSessionExtension } from '../../../acp/session-extensions';
import { errorMessage } from '../../../utils/conversionUtils';
import {
  createExtensionRecoverHints,
  formatExtensionErrorMessage,
} from '../../../utils/extensionErrorUtils';

export interface AgentExtensionMessages {
  adding: (name: string) => string;
  added: string;
  failedToAdd: string;
  removing: (name: string) => string;
  removed: string;
  failedToRemove: string;
}

export async function addToAgent(
  extensionConfig: ExtensionConfig,
  sessionId: string,
  showToast: boolean,
  messages: AgentExtensionMessages
) {
  const extensionName = extensionConfig.name;
  let toastId = showToast
    ? toastService.loading({
        title: extensionName,
        msg: messages.adding(extensionName),
      })
    : 0;

  try {
    await addSessionExtension(sessionId, extensionConfig);
    if (showToast) {
      toastService.dismiss(toastId);
      toastService.success({
        title: extensionName,
        msg: messages.added,
      });
    }
  } catch (error) {
    if (showToast) {
      toastService.dismiss(toastId);
      const errMsg = errorMessage(error);
      const recoverHints = createExtensionRecoverHints(errMsg);
      const msg = formatExtensionErrorMessage(errMsg, messages.failedToAdd);
      toastService.error({
        title: extensionName,
        msg: msg,
        traceback: errMsg,
        recoverHints,
      });
    }
    throw error;
  }
}

export async function removeFromAgent(
  extensionName: string,
  sessionId: string,
  showToast: boolean,
  messages: AgentExtensionMessages
) {
  let toastId = showToast
    ? toastService.loading({
        title: extensionName,
        msg: messages.removing(extensionName),
      })
    : 0;

  try {
    await removeSessionExtension(sessionId, extensionName);

    if (showToast) {
      toastService.dismiss(toastId);
      toastService.success({
        title: extensionName,
        msg: messages.removed,
      });
    }
  } catch (error) {
    if (showToast) {
      toastService.dismiss(toastId);
      const errMsg = errorMessage(error);
      const msg = formatExtensionErrorMessage(errMsg, messages.failedToRemove);
      toastService.error({
        title: extensionName,
        msg: msg,
        traceback: errMsg,
      });
    }
    throw error;
  }
}

export function sanitizeName(name: string) {
  return name.toLowerCase().replace(/-/g, '').replace(/_/g, '').replace(/\s/g, '');
}
