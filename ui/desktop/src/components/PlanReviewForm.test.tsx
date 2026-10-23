import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import ElicitationRequest from './ElicitationRequest';
import { getPlanReview } from './PlanReviewForm';
import type { JsonSchema } from './ui/JsonSchemaForm';
import type { ActionRequired } from '../types/message';
import { zCreateElicitationRequest } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import { elicitationContent } from '../acp/adapter/elicitations';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    answer_0: {
      type: 'string',
      title: 'Approve this plan and leave plan mode?',
      description: '# Create and verify\n\n1. Write `plan.txt`.\n2. Read it back.',
      _meta: {
        'codepro.dev/questionIntent': { kind: 'plan-review', approve: 'Approve', callId: 'tool-1' },
        'codepro.dev/suggestedOptions': [{ const: 'Approve' }, { const: 'Keep planning' }],
        'codepro.dev/feedbackField': 'feedback_0',
      },
    },
    feedback_0: { type: 'string' },
  },
  required: ['answer_0'],
};

function mount(onSubmit = vi.fn().mockResolvedValue(true)) {
  render(
    <ElicitationRequest
      standalone
      isClicked={false}
      isCancelledMessage={false}
      actionRequiredContent={
        {
          type: 'actionRequired',
          data: {
            actionType: 'elicitation',
            id: 'review-1',
            message: 'Approve this plan and leave plan mode?',
            requested_schema: schema,
          },
        } as ActionRequired & { type: 'actionRequired' }
      }
      onSubmit={onSubmit}
    />,
    { wrapper: IntlTestWrapper }
  );
  return onSubmit;
}

describe('native plan review', () => {
  it('retains native presentation hints through actual ACP SDK parsing', () => {
    const parsed = zCreateElicitationRequest.parse({
      mode: 'form',
      sessionId: 'session',
      message: 'Review',
      requestedSchema: schema,
      _meta: { 'codepro.dev/questionFields': { answer_0: schema.properties!.answer_0._meta } },
    });
    if (parsed.mode !== 'form' || !('sessionId' in parsed)) throw Error('Expected session form');
    const content = elicitationContent({ id: 'request', sessionId: 'session', request: parsed });
    if (content.data.actionType !== 'elicitation') throw Error('Expected elicitation');
    expect(getPlanReview(content.data.requested_schema as JsonSchema)).toEqual(
      getPlanReview(schema)
    );
  });
  it('renders the plan as Markdown once and approves only on explicit click', async () => {
    const submit = mount();
    expect(screen.getAllByRole('heading', { name: 'Create and verify' })).toHaveLength(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Approve this plan and leave plan mode?')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'Or write your own response'
    );
    expect(screen.getByText('Recommended')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: 'Approve and implement' }));
    expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(submit).toHaveBeenCalledWith('review-1', { answer_0: 'Approve', feedback_0: '' });
  });

  it('sends feedback separately, even if the user types the native approval label', async () => {
    const submit = mount();
    await userEvent.click(screen.getByRole('radio', { name: 'Approve and implement' }));
    await userEvent.type(screen.getByRole('textbox'), 'Approve');
    expect(screen.getByRole('radio', { name: 'Approve and implement' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(submit).toHaveBeenCalledWith('review-1', {
      answer_0: '',
      feedback_0: 'Approve',
    });
  });

  it('keeps the plan and draft actionable when the response fails', async () => {
    const submit = mount(vi.fn().mockResolvedValue(false));
    await userEvent.click(screen.getByRole('radio', { name: 'Keep planning' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(submit).toHaveBeenCalledWith('review-1', { answer_0: 'Keep planning', feedback_0: '' });
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Approve and implement' })).toBeEnabled();
  });

  it('falls back for unrecognized intent, ambiguous options or missing feedback field', () => {
    expect(getPlanReview(schema)).toBeDefined();
    for (const mutate of [
      (copy: JsonSchema) => {
        copy.properties!.answer_0._meta!['codepro.dev/questionIntent'] = {
          kind: 'other',
          approve: 'Approve',
        };
      },
      (copy: JsonSchema) => {
        copy.properties!.answer_0._meta!['codepro.dev/suggestedOptions'] = [
          { const: 'Approve' },
          { const: 'Approve' },
        ];
      },
      (copy: JsonSchema) => {
        delete copy.properties!.feedback_0;
      },
    ]) {
      const copy = JSON.parse(JSON.stringify(schema)) as JsonSchema;
      mutate(copy);
      expect(getPlanReview(copy)).toBeUndefined();
    }
  });
});
