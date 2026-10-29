import React, { useState, useEffect, useRef, FormEvent, useCallback } from 'react';
import type { ScheduledJobDto } from '@aaif/goose-sdk';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { Switch } from '../ui/switch';
import { ChevronDown } from 'lucide-react';
import { FriendlySchedulePicker } from './FriendlySchedulePicker';
import { Recipe, parseDeeplink, parseRecipeFromFile } from '../../recipe';
import { getStorageDirectory } from '../../recipe/recipe_management';
import { defineMessages, useIntl } from '../../i18n';
import type { WorkspaceMode } from '../../utils/navigationUtils';

const i18n = defineMessages({
  advanced: { id: 'scheduleModal.advanced', defaultMessage: 'Advanced' },
  prompt: { id: 'scheduleModal.prompt', defaultMessage: 'Task instructions' },
  promptPlaceholder: {
    id: 'scheduleModal.promptPlaceholder',
    defaultMessage: 'Describe what to do on each run, what to report, and when to stop.',
  },
  destination: { id: 'scheduleModal.destination', defaultMessage: 'Run in' },
  newSession: { id: 'scheduleModal.newSession', defaultMessage: 'A new chat each time' },
  currentSession: {
    id: 'scheduleModal.currentSession',
    defaultMessage: 'Follow up in the current chat',
  },
  followHint: {
    id: 'scheduleModal.followHint',
    defaultMessage:
      'Uses this chat’s history, model and permissions. Busy runs are skipped. Deleting the chat pauses the task.',
  },
  newHint: {
    id: 'scheduleModal.newHint',
    defaultMessage: 'Each run starts independently using the configured default model.',
  },
  noCurrentChat: {
    id: 'scheduleModal.noCurrentChat',
    defaultMessage: 'Open a chat first to create a follow-up.',
  },
  editSchedule: { id: 'scheduleModal.editSchedule', defaultMessage: 'Edit Schedule' },
  createNewSchedule: {
    id: 'scheduleModal.createNewSchedule',
    defaultMessage: 'Set up an automatic task',
  },
  nameLabel: { id: 'scheduleModal.nameLabel', defaultMessage: 'Name:' },
  namePlaceholder: {
    id: 'scheduleModal.namePlaceholder',
    defaultMessage: 'e.g., daily-summary-job',
  },
  sourceLabel: { id: 'scheduleModal.sourceLabel', defaultMessage: 'Source:' },
  yaml: { id: 'scheduleModal.yaml', defaultMessage: 'YAML' },
  deepLink: { id: 'scheduleModal.deepLink', defaultMessage: 'Deep link' },
  browseYaml: { id: 'scheduleModal.browseYaml', defaultMessage: 'Browse for YAML file...' },
  selected: { id: 'scheduleModal.selected', defaultMessage: 'Selected: {path}' },
  deepLinkPlaceholder: {
    id: 'scheduleModal.deepLinkPlaceholder',
    defaultMessage: 'Paste codebuddy://recipe link here...',
  },
  recipeParsed: { id: 'scheduleModal.recipeParsed', defaultMessage: 'Recipe parsed successfully' },
  recipeTitle: { id: 'scheduleModal.recipeTitle', defaultMessage: 'Title: {title}' },
  recipeDescription: {
    id: 'scheduleModal.recipeDescription',
    defaultMessage: 'Description: {description}',
  },
  scheduleLabel: { id: 'scheduleModal.scheduleLabel', defaultMessage: 'Schedule:' },
  cancel: { id: 'scheduleModal.cancel', defaultMessage: 'Cancel' },
  updating: { id: 'scheduleModal.updating', defaultMessage: 'Updating...' },
  creating: { id: 'scheduleModal.creating', defaultMessage: 'Creating...' },
  updateSchedule: { id: 'scheduleModal.updateSchedule', defaultMessage: 'Update Schedule' },
  createSchedule: { id: 'scheduleModal.createSchedule', defaultMessage: 'Create Schedule' },
  testAndEnable: {
    id: 'scheduleModal.testAndEnable',
    defaultMessage: 'Test & Enable',
  },
  invalidDeepLink: {
    id: 'scheduleModal.invalidDeepLink',
    defaultMessage: 'Invalid deep link. Please use a codebuddy://recipe link.',
  },
  failedReadFile: {
    id: 'scheduleModal.failedReadFile',
    defaultMessage: 'Failed to read the selected file.',
  },
  failedParseRecipe: {
    id: 'scheduleModal.failedParseRecipe',
    defaultMessage: 'Failed to parse recipe from file.',
  },
  invalidFileType: {
    id: 'scheduleModal.invalidFileType',
    defaultMessage: 'Invalid file type: Please select a YAML file (.yaml or .yml)',
  },
  scheduleIdRequired: {
    id: 'scheduleModal.scheduleIdRequired',
    defaultMessage: 'Schedule ID is required.',
  },
  provideValidRecipe: {
    id: 'scheduleModal.provideValidRecipe',
    defaultMessage: 'Please provide a valid recipe source.',
  },
  clockAlt: { id: 'scheduleModal.clockAlt', defaultMessage: 'Clock' },
});

export interface NewSchedulePayload {
  id: string;
  recipe: Recipe;
  cron: string;
  workspaceMode: WorkspaceMode;
  paused: boolean;
  tested: boolean;
  executionMode?: 'new_session' | 'current_session';
  targetSessionId?: string;
}

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: NewSchedulePayload | string) => Promise<void>;
  schedule: ScheduledJobDto | null;
  isLoadingExternally: boolean;
  apiErrorExternally: string | null;
  initialDeepLink: string | null;
  workspaceMode: WorkspaceMode;
  currentChat?: { id: string; name: string };
}

type SourceType = 'prompt' | 'file' | 'deeplink';

const modalLabelClassName = 'block text-sm text-text-primary mb-2';

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  schedule,
  isLoadingExternally,
  apiErrorExternally,
  initialDeepLink,
  workspaceMode,
  currentChat,
}) => {
  const intl = useIntl();
  const isEditMode = !!schedule;

  const [scheduleId, setScheduleId] = useState<string>('');
  const [sourceType, setSourceType] = useState<SourceType>('prompt');
  const [prompt, setPrompt] = useState('');
  const [executionMode, setExecutionMode] = useState<'new_session' | 'current_session'>(
    'new_session'
  );
  const [recipeSourcePath, setRecipeSourcePath] = useState<string>('');
  const [deepLinkInput, setDeepLinkInput] = useState<string>('');
  const [parsedRecipe, setParsedRecipe] = useState<Recipe | null>(null);
  const [cronExpression, setCronExpression] = useState<string>('0 0 14 * * *');
  const [internalValidationError, setInternalValidationError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(true);
  const initializedForm = useRef<string | null>(null);

  const setScheduleIdFromTitle = (title: string) => {
    const cleanId = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}-]/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    // Parsing is asynchronous; never replace a name the user has already entered.
    setScheduleId((current) => (current.trim() ? current : cleanId));
  };

  const handleDeepLinkChange = useCallback(
    async (value: string) => {
      setDeepLinkInput(value);
      setInternalValidationError(null);

      if (value.trim()) {
        try {
          const recipe = await parseDeeplink(value.trim());
          if (!recipe) throw new Error();
          setParsedRecipe(recipe);
          if (recipe.title) {
            setScheduleIdFromTitle(recipe.title);
          }
        } catch {
          setParsedRecipe(null);
          setInternalValidationError(intl.formatMessage(i18n.invalidDeepLink));
        }
      } else {
        setParsedRecipe(null);
      }
    },
    [intl]
  );

  useEffect(() => {
    if (!isOpen) {
      // The form is temporarily hidden while its test runs. Keep the draft so
      // a rejected test can reopen it without discarding the user's input.
      if (!isLoadingExternally) initializedForm.current = null;
      return;
    }
    const identity = JSON.stringify([schedule?.id ?? null, initialDeepLink]);
    if (initializedForm.current === identity) return;
    initializedForm.current = identity;
    if (isOpen) {
      if (schedule) {
        setScheduleId(schedule.id);
        setCronExpression(schedule.cron);
      } else {
        setScheduleId('');
        setSourceType('prompt');
        setPrompt('');
        setExecutionMode('new_session');
        setRecipeSourcePath('');
        setDeepLinkInput('');
        setParsedRecipe(null);
        setCronExpression('0 0 14 * * *');
        setInternalValidationError(null);
        if (initialDeepLink) {
          setSourceType('deeplink');
          handleDeepLinkChange(initialDeepLink);
        }
      }
    }
  }, [isOpen, isLoadingExternally, schedule, initialDeepLink, handleDeepLinkChange]);

  const handleBrowseFile = async () => {
    const defaultPath = getStorageDirectory(true);
    const filePath = await window.electron.selectFileOrDirectory(defaultPath);
    if (filePath) {
      if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        setRecipeSourcePath(filePath);
        setInternalValidationError(null);

        try {
          const fileResponse = await window.electron.readFile(filePath);
          if (!fileResponse.found || fileResponse.error) {
            throw new Error(intl.formatMessage(i18n.failedReadFile));
          }
          const recipe = await parseRecipeFromFile(fileResponse.file);
          if (!recipe) {
            throw new Error(intl.formatMessage(i18n.failedParseRecipe));
          }
          setParsedRecipe(recipe);
          if (recipe.title) {
            setScheduleIdFromTitle(recipe.title);
          }
        } catch (e) {
          setParsedRecipe(null);
          setInternalValidationError(
            e instanceof Error ? e.message : intl.formatMessage(i18n.failedParseRecipe)
          );
        }
      } else {
        setInternalValidationError(intl.formatMessage(i18n.invalidFileType));
      }
    }
  };

  const handleLocalSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setInternalValidationError(null);

    if (isEditMode) {
      await onSubmit(cronExpression);
      return;
    }

    const name =
      scheduleId.trim() ||
      (sourceType === 'prompt' ? prompt : (parsedRecipe?.title ?? ''))
        .trim()
        .split(/\r?\n/u)[0]
        .replace(/[\\/\0]/gu, ' ')
        .trim()
        .slice(0, 60);
    if (!name) {
      setInternalValidationError(intl.formatMessage(i18n.scheduleIdRequired));
      return;
    }

    const recipe =
      sourceType === 'prompt'
        ? {
            version: '1.0.0',
            title: name,
            description: name,
            prompt: prompt.trim(),
          }
        : parsedRecipe;
    if (!recipe || (sourceType === 'prompt' && !prompt.trim())) {
      setInternalValidationError(intl.formatMessage(i18n.provideValidRecipe));
      return;
    }
    if (executionMode === 'current_session' && !currentChat?.id) {
      setInternalValidationError(intl.formatMessage(i18n.noCurrentChat));
      return;
    }

    const newSchedulePayload: NewSchedulePayload = {
      id: name,
      recipe,
      cron: cronExpression,
      workspaceMode,
      paused: true,
      tested: false,
      executionMode,
      ...(executionMode === 'current_session' ? { targetSessionId: currentChat!.id } : {}),
    };

    await onSubmit(newSchedulePayload);
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isLoadingExternally && onClose()}>
      <DialogContent
        className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden rounded-3xl border-border-primary p-0 sm:max-w-[640px]"
        overlayClassName="bg-black/25"
        onInteractOutside={(event) => isLoadingExternally && event.preventDefault()}
        onEscapeKeyDown={(event) => isLoadingExternally && event.preventDefault()}
      >
        <div className="shrink-0 px-5 pb-4 pt-5">
          <DialogTitle className="pr-8 text-base font-semibold leading-6 text-text-primary">
            {isEditMode
              ? intl.formatMessage(i18n.editSchedule)
              : intl.formatMessage(i18n.createNewSchedule)}
          </DialogTitle>
          {isEditMode && <p className="text-sm text-text-secondary">{schedule.id}</p>}
          <DialogDescription className="sr-only">
            {intl.formatMessage(i18n.promptPlaceholder)}
          </DialogDescription>
        </div>

        <form
          id="schedule-form"
          onSubmit={handleLocalSubmit}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-2"
        >
          {apiErrorExternally && (
            <p className="text-text-danger text-sm mb-3 p-2 border border-border-danger rounded-md">
              {apiErrorExternally}
            </p>
          )}
          {internalValidationError && (
            <p className="text-text-danger text-sm mb-3 p-2 border border-border-danger rounded-md">
              {internalValidationError}
            </p>
          )}

          {!isEditMode && (
            <>
              {sourceType === 'prompt' && (
                <textarea
                  aria-label={intl.formatMessage(i18n.prompt)}
                  className="block min-h-32 w-full resize-y rounded-2xl border border-border-primary bg-transparent px-4 py-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-secondary focus:border-text-secondary"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={5}
                  placeholder={intl.formatMessage(i18n.promptPlaceholder)}
                  required
                />
              )}

              {sourceType === 'file' && (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBrowseFile}
                    className="w-full justify-center rounded-full"
                  >
                    {intl.formatMessage(i18n.browseYaml)}
                  </Button>
                  {recipeSourcePath && (
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 italic">
                      {intl.formatMessage(i18n.selected, { path: recipeSourcePath })}
                    </p>
                  )}
                </div>
              )}

              {sourceType === 'deeplink' && (
                <div>
                  <Input
                    type="text"
                    value={deepLinkInput}
                    onChange={(e) => handleDeepLinkChange(e.target.value)}
                    placeholder={intl.formatMessage(i18n.deepLinkPlaceholder)}
                    className="rounded-xl"
                  />
                  {parsedRecipe && (
                    <div className="mt-2 p-2 bg-green-100 dark:bg-green-900/30 rounded-md border border-green-500/50">
                      <p className="text-xs text-green-700 dark:text-green-300 font-medium">
                        ✓ {intl.formatMessage(i18n.recipeParsed)}
                      </p>
                      <p className="text-xs text-green-600 dark:text-green-400">
                        {intl.formatMessage(i18n.recipeTitle, { title: parsedRecipe.title })}
                      </p>
                      <p className="text-xs text-green-600 dark:text-green-400">
                        {intl.formatMessage(i18n.recipeDescription, {
                          description: parsedRecipe.description,
                        })}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <FriendlySchedulePicker
            schedule={schedule}
            onChange={setCronExpression}
            isValid={setIsValid}
          />

          {!isEditMode && (
            <details className="group/advanced pb-1" open={initialDeepLink ? true : undefined}>
              <summary className="mb-3 flex w-fit cursor-pointer list-none items-center gap-1 rounded-lg px-1 py-1 text-xs text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-primary [&::-webkit-details-marker]:hidden">
                {intl.formatMessage(i18n.advanced)}
                <ChevronDown className="size-3 transition-transform duration-200 group-open/advanced:rotate-180" />
              </summary>
              <div className="space-y-3">
                <div className="rounded-2xl border border-border-primary px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <label htmlFor="schedule-new-chat" className="text-sm text-text-primary">
                      {intl.formatMessage(i18n.newSession)}
                    </label>
                    <Switch
                      id="schedule-new-chat"
                      variant="mono"
                      checked={executionMode === 'new_session'}
                      disabled={!currentChat?.id}
                      onCheckedChange={(checked) => {
                        setExecutionMode(checked ? 'new_session' : 'current_session');
                        if (!checked) setSourceType('prompt');
                      }}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-text-secondary">
                    {executionMode === 'current_session' && currentChat?.name && (
                      <span className="block truncate" title={currentChat.name}>
                        {currentChat.name}
                      </span>
                    )}
                    {intl.formatMessage(
                      executionMode === 'current_session' ? i18n.followHint : i18n.newHint
                    )}
                  </p>
                  {!currentChat?.id && (
                    <p className="mt-1 text-xs text-text-secondary">
                      {intl.formatMessage(i18n.noCurrentChat)}
                    </p>
                  )}
                </div>
                <div className="rounded-2xl border border-border-primary px-4 py-3">
                  <label htmlFor="scheduleId-modal" className={modalLabelClassName}>
                    {intl.formatMessage(i18n.nameLabel)}
                  </label>
                  <Input
                    id="scheduleId-modal"
                    value={scheduleId}
                    onChange={(e) => setScheduleId(e.target.value)}
                    placeholder={intl.formatMessage(i18n.namePlaceholder)}
                    className="h-9 rounded-lg text-sm"
                  />
                </div>
                <div className="rounded-2xl border border-border-primary px-4 py-3">
                  <span className={modalLabelClassName}>
                    {intl.formatMessage(i18n.sourceLabel)}
                  </span>
                  <div className="flex flex-wrap gap-1 rounded-xl bg-background-secondary p-1">
                    {(['prompt', 'file', 'deeplink'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        disabled={type !== 'prompt' && executionMode === 'current_session'}
                        aria-pressed={sourceType === type}
                        onClick={() => setSourceType(type)}
                        className={`flex-1 rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${sourceType === type ? 'bg-background-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                      >
                        {intl.formatMessage(
                          type === 'prompt'
                            ? i18n.prompt
                            : type === 'file'
                              ? i18n.yaml
                              : i18n.deepLink
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          )}
        </form>

        <div className="flex shrink-0 justify-end gap-2 bg-background-primary px-5 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isLoadingExternally}
            className="h-9 rounded-full bg-background-secondary px-5 text-sm text-text-primary hover:opacity-80"
          >
            {intl.formatMessage(i18n.cancel)}
          </Button>
          <Button
            type="submit"
            form="schedule-form"
            disabled={
              isLoadingExternally ||
              !isValid ||
              (!isEditMode && (sourceType === 'prompt' ? !prompt.trim() : !parsedRecipe))
            }
            className="h-9 rounded-full px-5 text-sm"
          >
            {isLoadingExternally
              ? isEditMode
                ? intl.formatMessage(i18n.updating)
                : intl.formatMessage(i18n.creating)
              : isEditMode
                ? intl.formatMessage(i18n.updateSchedule)
                : intl.formatMessage(i18n.testAndEnable)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
