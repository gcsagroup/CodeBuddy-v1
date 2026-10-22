import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import JsonSchemaForm from './JsonSchemaForm';
import type { JsonSchema } from './JsonSchemaForm';
import { elicitationContent } from '../../acp/adapter/elicitations';
import { zCreateElicitationRequest } from '@agentclientprotocol/sdk/dist/schema/zod.gen';

describe('JsonSchemaForm', () => {
  it('keeps choice suggestions and custom answers together without relaxing ordinary enums', async () => {
    const user = userEvent.setup(),
      onSubmit = vi.fn();
    const request = zCreateElicitationRequest.parse({
      sessionId: 'question-test',
      mode: 'form',
      message: '',
      requestedSchema: {
        type: 'object',
        properties: {
          answer: {
            type: 'array',
            title: 'Choose',
            items: { type: 'string', enum: ['Mint', 'Cream'] },
          },
          answer_custom: { type: 'string' },
        },
      },
      _meta: {
        'codepro/questionFields': {
          answer: {
            options: [{ label: 'Mint', description: 'Cool' }, { label: 'Cream' }],
            customKey: 'answer_custom',
          },
        },
      },
    });
    if (request.mode !== 'form' || !('sessionId' in request)) throw Error('Expected session form');
    const content = elicitationContent({
      id: 'question',
      sessionId: request.sessionId,
      request,
      expiresAt: Date.now() + 300_000,
    });
    if (content.data.actionType !== 'elicitation') throw Error('Expected question content');
    const { rerender } = render(
      <JsonSchemaForm
        compact
        onSubmit={onSubmit}
        schema={content.data.requested_schema as JsonSchema}
      />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('checkbox', { name: /Mint/ }));
    await user.type(screen.getByRole('textbox', { name: 'Your own answer (optional)' }), 'Blue');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith({ answer: ['Mint'], answer_custom: 'Blue' });
    rerender(
      <JsonSchemaForm
        onSubmit={onSubmit}
        schema={{ properties: { answer: { type: 'string', enum: ['Mint', 'Cream'] } } }}
      />
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('walks through single choice, multi choice, and text while retaining answers', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <JsonSchemaForm
        schema={{
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              title: 'Which scope?',
              oneOf: [
                { const: 'backup', title: 'Backup only' },
                { const: 'project', title: 'Current project' },
              ],
            },
            goals: {
              type: 'array',
              title: 'What should be checked?',
              items: {
                anyOf: [
                  { const: 'history', title: 'History' },
                  { const: 'health', title: 'Project health' },
                ],
              },
              _meta: {
                'codepro.dev/optionDescriptions': {
                  health: 'Review architecture and test coverage',
                },
              },
            },
            notes: { type: 'string', title: 'Anything else?', maxLength: 1000 },
          },
          required: ['scope'],
        }}
        onSubmit={onSubmit}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('1 / 3')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: /Current project/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('2 / 3')).toBeVisible();
    expect(screen.getByText('Review architecture and test coverage')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /History/ }));
    await user.click(screen.getByRole('checkbox', { name: /Project health/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('3 / 3')).toBeVisible();
    await user.type(screen.getByRole('textbox'), 'Keep the source tree');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('checkbox', { name: /History/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('textbox')).toHaveValue('Keep the source tree');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onSubmit).toHaveBeenCalledWith({
      scope: 'project',
      goals: ['history', 'health'],
      notes: 'Keep the source tree',
    });
  });

  it('blocks the next step until a required question is answered', async () => {
    const user = userEvent.setup();
    render(
      <JsonSchemaForm
        schema={{
          properties: {
            scope: {
              type: 'string',
              title: 'Which scope?',
              oneOf: [
                { const: 'one', title: 'One' },
                { const: 'two', title: 'Two' },
              ],
            },
            notes: { type: 'string', title: 'Notes' },
          },
          required: ['scope'],
        }}
        onSubmit={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This field is required');
    expect(screen.getByText('1 / 2')).toBeVisible();
  });

  it('cancels without submitting answers', async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(
      <JsonSchemaForm
        schema={{ properties: { notes: { type: 'string', title: 'Notes' } } }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
      { wrapper: IntlTestWrapper }
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
