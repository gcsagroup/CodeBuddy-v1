import { Play } from 'lucide-react';
import type { CommonTaskModel } from './commonTaskModel';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

export interface CommonTaskCreationLabels {
  title: string;
  descriptionTitle: string;
  descriptionHelp: string;
  descriptionPlaceholder: string;
  cancel: string;
  manualSetup: string;
  continueInNewTask: string;
}

interface CommonTaskCreationDialogProps {
  open: boolean;
  description: string;
  labels: CommonTaskCreationLabels;
  onOpenChange: (open: boolean) => void;
  onDescriptionChange: (description: string) => void;
  onDescribe: () => void;
  onManualSetup: () => void;
}

export function CommonTaskCreationDialog({
  open,
  description,
  labels,
  onOpenChange,
  onDescriptionChange,
  onDescribe,
  onManualSetup,
}: CommonTaskCreationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="font-medium">{labels.descriptionTitle}</p>
            <p className="text-sm text-text-secondary">{labels.descriptionHelp}</p>
          </div>
          <textarea
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder={labels.descriptionPlaceholder}
            className="min-h-28 w-full resize-y rounded-md border border-border-default bg-background-default p-3 text-sm outline-none focus:border-border-accent"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {labels.cancel}
            </Button>
            <Button variant="outline" onClick={onManualSetup}>
              {labels.manualSetup}
            </Button>
            <Button onClick={onDescribe} disabled={!description.trim()}>
              {labels.continueInNewTask}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface CommonTaskRunSummaryLabels {
  title: string;
  help: string;
  model: (model: string) => string;
  tools: (tools: string[]) => string;
  files: (files: string[]) => string;
  noDeclaredTools: string;
  noKnownFiles: string;
  externalToolRisk: string;
  cancel: string;
  run: string;
}

interface CommonTaskRunSummaryDialogProps {
  task: CommonTaskModel | null;
  labels: CommonTaskRunSummaryLabels;
  onClose: () => void;
  onRun: (taskId: string) => void;
}

export function CommonTaskRunSummaryDialog({
  task,
  labels,
  onClose,
  onRun,
}: CommonTaskRunSummaryDialogProps) {
  if (!task) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{labels.help}</p>
          <p className="font-medium">{task.title}</p>
          <div className="space-y-1 rounded-md bg-background-secondary p-3 text-sm">
            <p>{labels.model(task.model)}</p>
            <p>{task.extensions.length ? labels.tools(task.extensions) : labels.noDeclaredTools}</p>
            <p>{task.knownFiles.length ? labels.files(task.knownFiles) : labels.noKnownFiles}</p>
            {task.riskSummary.map((risk) => (
              <p key={risk} className="text-amber-700 dark:text-amber-300">
                {risk === 'External tool access may require confirmation'
                  ? labels.externalToolRisk
                  : risk}
              </p>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {labels.cancel}
            </Button>
            <Button onClick={() => onRun(task.id)}>
              <Play className="mr-1 h-4 w-4" />
              {labels.run}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
