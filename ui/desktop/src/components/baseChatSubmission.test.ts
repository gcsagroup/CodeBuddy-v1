import { describe, expect, it, vi } from 'vitest';
import type { MessageSubmissionLifecycle } from '../hooks/useChatSessionTypes';
import type { UserInput } from '../types/message';
import { createChatInputSubmitHandler } from './baseChatSubmission';

describe('BaseChat input submission', () => {
  it('forwards the acceptance lifecycle so an accepted follow-up clears the draft', async () => {
    const lifecycle: MessageSubmissionLifecycle = {
      onAccepted: vi.fn(),
      onRejectedBeforeAcceptance: vi.fn(),
    };
    const input: UserInput = { msg: 'follow-up', images: [] };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const markRecipeStarted = vi.fn();
    const submit = createChatInputSubmitHandler(handleSubmit, true, markRecipeStarted);

    await submit(input, lifecycle);

    expect(handleSubmit).toHaveBeenCalledWith(input, lifecycle);
    expect(markRecipeStarted).toHaveBeenCalledOnce();
  });
});
