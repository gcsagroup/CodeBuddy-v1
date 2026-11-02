import React, { useState, useEffect, useRef, FormEvent, useCallback } from 'react';
import type { ScheduledJobDto, RecipeSettingsDto } from '@aaif/goose-sdk';
import { ScheduleModelControls } from './ScheduleModelControls';
import { ScheduleChatPicker } from './ScheduleChatPicker';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { Switch } from '../ui/switch';
import { ChevronDown } from 'lucide-react';
import { FriendlySchedulePicker } from './FriendlySchedulePicker';
import { Recipe, parseDeeplink } from '../../recipe';
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
  newSession: { id: 'scheduleModal.newSession', defaultMessage: 'Open a new chat on every run' },
  currentSession: {
    id: 'scheduleModal.currentSession',
    defaultMessage: 'Follow up in the current chat',
  },
  followHint: {
    id: 'scheduleModal.followHint',
    defaultMessage:
      'Uses this chat’s history, model and permissions. Busy runs are skipped. Deleting the chat pauses the task.',
  },
  noCurrentChat: {
    id: 'scheduleModal.noCurrentChat',
    defaultMessage: 'Choose a chat for this follow-up.',
  },
  editSchedule: { id: 'scheduleModal.editSchedule', defaultMessage: 'Edit Schedule' },
  createNewSchedule: {
    id: 'scheduleModal.createNewSchedule',
    defaultMessage: 'Set up an automatic task',
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

type SourceType = 'prompt' | 'deeplink';

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

  const [sourceType, setSourceType] = useState<SourceType>('prompt');
  const [prompt, setPrompt] = useState('');
  const [selectedChat, setSelectedChat] = useState<{ id: string; name: string }>();
  const followChat = selectedChat ?? currentChat;
  const [modelSettings, setModelSettings] = useState<RecipeSettingsDto | undefined>();
  const [executionMode, setExecutionMode] = useState<'new_session' | 'current_session'>(
    'new_session'
  );
  const [parsedRecipe, setParsedRecipe] = useState<Recipe | null>(null);
  const [cronExpression, setCronExpression] = useState<string>('0 0 14 * * *');
  const [internalValidationError, setInternalValidationError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(true);
  const initializedForm = useRef<string | null>(null);

  const handleDeepLinkChange = useCallback(
    async (value: string) => {
      setInternalValidationError(null);

      if (value.trim()) {
        try {
          const recipe = await parseDeeplink(value.trim());
          if (!recipe) throw new Error();
          setParsedRecipe(recipe);
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
        setCronExpression(schedule.cron);
      } else {
        setSourceType('prompt');
        setPrompt('');
        setModelSettings(undefined);
        setSelectedChat(undefined);
        setExecutionMode('new_session');
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

  const handleLocalSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setInternalValidationError(null);

    if (isEditMode) {
      await onSubmit(cronExpression);
      return;
    }

    const name = (sourceType === 'prompt' ? prompt : (parsedRecipe?.title ?? ''))
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
    if (executionMode === 'current_session' && !followChat?.id) {
      setInternalValidationError(intl.formatMessage(i18n.noCurrentChat));
      return;
    }

    const newSchedulePayload: NewSchedulePayload = {
      id: name,
      recipe:
        executionMode === 'new_session' && modelSettings
          ? { ...recipe, settings: { ...recipe.settings, ...modelSettings } }
          : recipe,
      cron: cronExpression,
      workspaceMode,
      paused: true,
      tested: false,
      executionMode,
      ...(executionMode === 'current_session' ? { targetSessionId: followChat!.id } : {}),
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

              {sourceType === 'deeplink' && (
                <div>
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
                <div className="flex min-h-12 items-center justify-between gap-4 rounded-2xl border border-border-primary px-4 py-2">
                  <label htmlFor="schedule-new-chat" className="text-sm text-text-primary">
                    {intl.formatMessage(i18n.newSession)}
                  </label>
                  <Switch
                    id="schedule-new-chat"
                    variant="mono"
                    className="h-5 w-8 data-[state=checked]:bg-blue-500 [&>span]:h-4 [&>span]:w-4"
                    checked={executionMode === 'new_session'}
                    onCheckedChange={(checked) => {
                      setExecutionMode(checked ? 'new_session' : 'current_session');
                      if (!checked) setSourceType('prompt');
                    }}
                  />
                </div>
                {executionMode === 'current_session' && (
                  <ScheduleChatPicker
                    value={followChat}
                    onChange={setSelectedChat}
                    workspaceMode={workspaceMode}
                  />
                )}
                {(executionMode === 'new_session' || followChat?.id) && (
                  <ScheduleModelControls
                    value={modelSettings ?? parsedRecipe?.settings}
                    onChange={setModelSettings}
                    followChatId={executionMode === 'current_session' ? followChat?.id : undefined}
                  />
                )}
                {executionMode === 'current_session' && (
                  <p className="px-1 text-xs leading-5 text-text-secondary">
                    {intl.formatMessage(followChat?.id ? i18n.followHint : i18n.noCurrentChat)}
                  </p>
                )}
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
              (!isEditMode && executionMode === 'current_session' && !followChat?.id) ||
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
