import type { MessageSubmissionLifecycle } from '../hooks/useChatSessionTypes';
import type { UserInput } from '../types/message';

type SubmitMessage = (
  input: UserInput,
  lifecycle?: MessageSubmissionLifecycle
) => Promise<void> | void;

export function createChatInputSubmitHandler(
  handleSubmit: SubmitMessage,
  hasRecipe: boolean,
  markRecipeStarted: () => void
): SubmitMessage {
  return async (input, lifecycle) => {
    if (hasRecipe && input.msg.trim()) {
      markRecipeStarted();
    }
    await handleSubmit(input, lifecycle);
  };
}
