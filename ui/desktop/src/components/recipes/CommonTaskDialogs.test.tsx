import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import {
  CommonTaskCreationDialog,
  CommonTaskRunSummaryDialog,
  type CommonTaskCreationLabels,
  type CommonTaskRunSummaryLabels,
} from './CommonTaskDialogs';

const creationLabels: CommonTaskCreationLabels = {
  title: 'Create Common Task',
  descriptionTitle: 'Describe what I need',
  descriptionHelp: 'Review before saving.',
  descriptionPlaceholder: 'Describe recurring work',
  cancel: 'Cancel',
  manualSetup: 'Manual setup',
  continueInNewTask: 'Continue in new task',
};

const runLabels: CommonTaskRunSummaryLabels = {
  title: 'Review before running',
  help: 'Runtime permission prompts still apply.',
  model: (model) => `Model: ${model}`,
  tools: (tools) => `Tools: ${tools.join(', ')}`,
  files: (files) => `Files: ${files.join(', ')}`,
  noDeclaredTools: 'Tools: none declared',
  noKnownFiles: 'Files: none declared',
  externalToolRisk: 'External tool access may require confirmation',
  cancel: 'Cancel',
  run: 'Run',
};

describe('Common Task dialogs', () => {
  it('offers natural-language and manual creation without accepting a blank description', () => {
    const onDescriptionChange = vi.fn();
    const onDescribe = vi.fn();
    const onManualSetup = vi.fn();
    const { rerender } = render(
      <IntlProvider locale="en">
        <CommonTaskCreationDialog
          open
          description=""
          labels={creationLabels}
          onOpenChange={vi.fn()}
          onDescriptionChange={onDescriptionChange}
          onDescribe={onDescribe}
          onManualSetup={onManualSetup}
        />
      </IntlProvider>
    );

    expect(screen.getByRole('button', { name: 'Continue in new task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Manual setup' }));
    expect(onManualSetup).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByPlaceholderText('Describe recurring work'), {
      target: { value: 'Review releases' },
    });
    expect(onDescriptionChange).toHaveBeenCalledWith('Review releases');

    rerender(
      <IntlProvider locale="en">
        <CommonTaskCreationDialog
          open
          description="Review releases"
          labels={creationLabels}
          onOpenChange={vi.fn()}
          onDescriptionChange={onDescriptionChange}
          onDescribe={onDescribe}
          onManualSetup={onManualSetup}
        />
      </IntlProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue in new task' }));
    expect(onDescribe).toHaveBeenCalledOnce();
  });

  it('shows the declared run summary and starts only after confirmation', () => {
    const onRun = vi.fn();
    render(
      <IntlProvider locale="en">
        <CommonTaskRunSummaryDialog
          task={{
            id: 'release-check',
            title: 'Release check',
            purpose: 'Validate a release',
            model: 'openai / gpt-5',
            extensions: ['filesystem'],
            knownFiles: ['artifact'],
            riskSummary: ['External tool access may require confirmation'],
          }}
          labels={runLabels}
          onClose={vi.fn()}
          onRun={onRun}
        />
      </IntlProvider>
    );

    expect(screen.getByText('Model: openai / gpt-5')).toBeVisible();
    expect(screen.getByText('Tools: filesystem')).toBeVisible();
    expect(screen.getByText('Files: artifact')).toBeVisible();
    expect(screen.getByText('External tool access may require confirmation')).toBeVisible();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onRun).toHaveBeenCalledWith('release-check');
  });
});
