import { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import {
  convertToLocaleDateString,
  deleteRecipe,
  listSavedRecipes,
  recipeToYaml,
  scheduleRecipe,
  setRecipeSlashCommand,
} from '../../recipe/recipe_management';
import type { RecipeManifest } from '../../recipe';
import {
  FileText,
  Edit,
  Trash2,
  Play,
  Calendar,
  AlertCircle,
  Link,
  Clock,
  Terminal,
  ExternalLink,
  Share2,
  Copy,
  Download,
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Card } from '../ui/card';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { toastSuccess, toastError } from '../../toasts';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { createSession } from '../../sessions';
import {
  listCapabilityUsage,
  recordCapabilitySuccess,
  recordCommonTaskSessionStarted,
  type CapabilityUsageEvent,
  type CapabilityUsageRecord,
} from '../../acp/capabilityUsage';
import { isRecipeParamsCancelled } from '../../acp/errors';
import ImportRecipeForm, { ImportRecipeButton } from './ImportRecipeForm';
import CreateEditRecipeModal from './CreateEditRecipeModal';
import { generateDeepLink } from '../../recipe';
import { useNavigation } from '../../hooks/useNavigation';
import { CronPicker } from '../schedule/CronPicker';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { SearchView } from '../conversation/SearchView';
import cronstrue from 'cronstrue';
import { getInitialWorkingDir, runWithOrdinaryWorkingDir } from '../../utils/workingDir';
import { buildCommonTaskCreationPrompt, buildCommonTaskModel } from './commonTaskModel';
import { CommonTaskCreationDialog, CommonTaskRunSummaryDialog } from './CommonTaskDialogs';
import {
  trackRecipeDeleted,
  trackRecipeStarted,
  trackRecipeDeeplinkCopied,
  trackRecipeYamlCopied,
  trackRecipeExportedToFile,
  trackRecipeScheduled,
  trackRecipeSlashCommandSet,
  getErrorType,
} from '../../utils/analytics';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { getSearchShortcutText } from '../../utils/keyboardShortcuts';
import { errorMessage } from '../../utils/conversionUtils';
import { AppEvents } from '../../constants/events';
import { defineMessages, useIntl } from '../../i18n';
import { getWorkspaceModeFromPath } from '../../utils/navigationUtils';

const i18n = defineMessages({
  deleteRecipeTitle: {
    id: 'recipesView.deleteRecipeTitle',
    defaultMessage: 'Delete Recipe',
  },
  deleteRecipeConfirm: {
    id: 'recipesView.deleteRecipeConfirm',
    defaultMessage: 'Are you sure you want to delete "{title}"?',
  },
  deleteRecipeDetail: {
    id: 'recipesView.deleteRecipeDetail',
    defaultMessage: 'Recipe file will be deleted.',
  },
  recipeDeletedSuccess: {
    id: 'recipesView.recipeDeletedSuccess',
    defaultMessage: 'Recipe deleted successfully',
  },
  deeplinkCopiedTitle: {
    id: 'recipesView.deeplinkCopiedTitle',
    defaultMessage: 'Deeplink copied',
  },
  deeplinkCopiedMsg: {
    id: 'recipesView.deeplinkCopiedMsg',
    defaultMessage: 'Recipe deeplink has been copied to clipboard',
  },
  copyFailedTitle: {
    id: 'recipesView.copyFailedTitle',
    defaultMessage: 'Copy failed',
  },
  copyDeeplinkFailedMsg: {
    id: 'recipesView.copyDeeplinkFailedMsg',
    defaultMessage: 'Failed to copy deeplink to clipboard',
  },
  yamlCopiedTitle: {
    id: 'recipesView.yamlCopiedTitle',
    defaultMessage: 'YAML copied',
  },
  yamlCopiedMsg: {
    id: 'recipesView.yamlCopiedMsg',
    defaultMessage: 'Recipe YAML has been copied to clipboard',
  },
  copyYamlFailedMsg: {
    id: 'recipesView.copyYamlFailedMsg',
    defaultMessage: 'Failed to copy recipe YAML to clipboard',
  },
  exportRecipeDialogTitle: {
    id: 'recipesView.exportRecipeDialogTitle',
    defaultMessage: 'Export Recipe',
  },
  yamlFiles: {
    id: 'recipesView.yamlFiles',
    defaultMessage: 'YAML Files',
  },
  allFiles: {
    id: 'recipesView.allFiles',
    defaultMessage: 'All Files',
  },
  recipeExportedTitle: {
    id: 'recipesView.recipeExportedTitle',
    defaultMessage: 'Recipe exported',
  },
  recipeExportedMsg: {
    id: 'recipesView.recipeExportedMsg',
    defaultMessage: 'Recipe saved to {filePath}',
  },
  exportFailedTitle: {
    id: 'recipesView.exportFailedTitle',
    defaultMessage: 'Export failed',
  },
  exportFailedMsg: {
    id: 'recipesView.exportFailedMsg',
    defaultMessage: 'Failed to export recipe to file',
  },
  scheduleSavedTitle: {
    id: 'recipesView.scheduleSavedTitle',
    defaultMessage: 'Schedule saved',
  },
  scheduleSavedMsg: {
    id: 'recipesView.scheduleSavedMsg',
    defaultMessage: 'Recipe will run {schedule}',
  },
  scheduleRemovedTitle: {
    id: 'recipesView.scheduleRemovedTitle',
    defaultMessage: 'Schedule removed',
  },
  scheduleRemovedMsg: {
    id: 'recipesView.scheduleRemovedMsg',
    defaultMessage: 'Recipe will no longer run automatically',
  },
  slashCommandSavedTitle: {
    id: 'recipesView.slashCommandSavedTitle',
    defaultMessage: 'Slash command saved',
  },
  slashCommandSavedMsg: {
    id: 'recipesView.slashCommandSavedMsg',
    defaultMessage: 'Use /{command} to run this recipe',
  },
  slashCommandRemovedTitle: {
    id: 'recipesView.slashCommandRemovedTitle',
    defaultMessage: 'Slash command removed',
  },
  slashCommandRemovedMsg: {
    id: 'recipesView.slashCommandRemovedMsg',
    defaultMessage: 'Recipe slash command has been removed',
  },
  runs: {
    id: 'recipesView.runs',
    defaultMessage: 'Runs {schedule}',
  },
  editSlashCommand: {
    id: 'recipesView.editSlashCommand',
    defaultMessage: 'Edit slash command',
  },
  addSlashCommand: {
    id: 'recipesView.addSlashCommand',
    defaultMessage: 'Add slash command',
  },
  useRecipe: {
    id: 'recipesView.useRecipe',
    defaultMessage: 'Run',
  },
  openInNewWindow: {
    id: 'recipesView.openInNewWindow',
    defaultMessage: 'Open in new window',
  },
  editRecipe: {
    id: 'recipesView.editRecipe',
    defaultMessage: 'Edit',
  },
  shareRecipe: {
    id: 'recipesView.shareRecipe',
    defaultMessage: 'Share recipe',
  },
  copyDeeplink: {
    id: 'recipesView.copyDeeplink',
    defaultMessage: 'Copy Deeplink',
  },
  copyYaml: {
    id: 'recipesView.copyYaml',
    defaultMessage: 'Copy YAML',
  },
  exportToFile: {
    id: 'recipesView.exportToFile',
    defaultMessage: 'Export to File',
  },
  editSchedule: {
    id: 'recipesView.editSchedule',
    defaultMessage: 'Edit schedule',
  },
  addSchedule: {
    id: 'recipesView.addSchedule',
    defaultMessage: 'Set automatic',
  },
  deleteRecipe: {
    id: 'recipesView.deleteRecipe',
    defaultMessage: 'Delete recipe',
  },
  errorLoadingRecipes: {
    id: 'recipesView.errorLoadingRecipes',
    defaultMessage: 'Error Loading Recipes',
  },
  tryAgain: {
    id: 'recipesView.tryAgain',
    defaultMessage: 'Try Again',
  },
  noSavedRecipes: {
    id: 'recipesView.noSavedRecipes',
    defaultMessage: 'No common tasks yet',
  },
  noSavedRecipesDescription: {
    id: 'recipesView.noSavedRecipesDescription',
    defaultMessage: 'Common tasks saved from chats will show up here.',
  },
  noMatchingRecipes: {
    id: 'recipesView.noMatchingRecipes',
    defaultMessage: 'No matching recipes found',
  },
  adjustSearchTerms: {
    id: 'recipesView.adjustSearchTerms',
    defaultMessage: 'Try adjusting your search terms',
  },
  recipesTitle: {
    id: 'recipesView.recipesTitle',
    defaultMessage: 'Common Tasks',
  },
  createRecipe: {
    id: 'recipesView.createRecipe',
    defaultMessage: 'Create Common Task',
  },
  describeTask: {
    id: 'recipesView.describeTask',
    defaultMessage: 'Describe what I need',
  },
  describeTaskHelp: {
    id: 'recipesView.describeTaskHelp',
    defaultMessage:
      'Start a new task with your description. CodeBuddy will help you confirm the reusable setup before saving.',
  },
  describeTaskPlaceholder: {
    id: 'recipesView.describeTaskPlaceholder',
    defaultMessage:
      'For example: every Friday, review the release notes and prepare a concise report...',
  },
  continueInNewTask: {
    id: 'recipesView.continueInNewTask',
    defaultMessage: 'Continue in new task',
  },
  manualSetup: {
    id: 'recipesView.manualSetup',
    defaultMessage: 'Manual setup',
  },
  recipesDescription: {
    id: 'recipesView.recipesDescription',
    defaultMessage:
      'Run repeatable work with known models, tools, files, and permissions. {shortcut} to search.',
  },
  searchRecipesPlaceholder: {
    id: 'recipesView.searchRecipesPlaceholder',
    defaultMessage: 'Search common tasks...',
  },
  modelLabel: { id: 'recipesView.modelLabel', defaultMessage: 'Model: {model}' },
  toolsLabel: { id: 'recipesView.toolsLabel', defaultMessage: 'Tools: {tools}' },
  filesLabel: { id: 'recipesView.filesLabel', defaultMessage: 'Files: {files}' },
  defaultModel: { id: 'recipesView.defaultModel', defaultMessage: 'Default model' },
  externalToolRisk: {
    id: 'recipesView.externalToolRisk',
    defaultMessage: 'External tool access may require confirmation',
  },
  lastRun: { id: 'recipesView.lastRun', defaultMessage: 'Last run: {time}' },
  neverRun: { id: 'recipesView.neverRun', defaultMessage: 'Never' },
  recentResult: { id: 'recipesView.recentResult', defaultMessage: 'Recent result: {result}' },
  noRecentResult: { id: 'recipesView.noRecentResult', defaultMessage: 'No runs yet' },
  sessionStarted: { id: 'recipesView.sessionStarted', defaultMessage: 'Session started' },
  runSummaryTitle: {
    id: 'recipesView.runSummaryTitle',
    defaultMessage: 'Review before running',
  },
  runSummaryHelp: {
    id: 'recipesView.runSummaryHelp',
    defaultMessage:
      'Review the declared model, tools, files, and permissions. Runtime permission prompts still apply.',
  },
  noDeclaredTools: {
    id: 'recipesView.noDeclaredTools',
    defaultMessage: 'Tools: none declared',
  },
  noKnownFiles: {
    id: 'recipesView.noKnownFiles',
    defaultMessage: 'Files: none declared',
  },
  scheduleDialogTitle: {
    id: 'recipesView.scheduleDialogTitle',
    defaultMessage: '{action} Schedule',
  },
  removeSchedule: {
    id: 'recipesView.removeSchedule',
    defaultMessage: 'Remove Schedule',
  },
  cancel: {
    id: 'recipesView.cancel',
    defaultMessage: 'Cancel',
  },
  save: {
    id: 'recipesView.save',
    defaultMessage: 'Save',
  },
  slashCommandTitle: {
    id: 'recipesView.slashCommandTitle',
    defaultMessage: 'Slash Command',
  },
  slashCommandDescription: {
    id: 'recipesView.slashCommandDescription',
    defaultMessage: 'Set a slash command to quickly run this recipe from any chat',
  },
  slashCommandPlaceholder: {
    id: 'recipesView.slashCommandPlaceholder',
    defaultMessage: 'command-name',
  },
  slashCommandUsageHint: {
    id: 'recipesView.slashCommandUsageHint',
    defaultMessage: 'Use /{command} in any chat to run this recipe',
  },
  remove: {
    id: 'recipesView.remove',
    defaultMessage: 'Remove',
  },
});

export const getRecipeWorkspaceMode = getWorkspaceModeFromPath;

type RecipeSession = Awaited<ReturnType<typeof createSession>>;

interface RecipeSessionDependencies {
  create: typeof createSession;
  getExplicitDir: () => string;
  chooseOrdinary: (
    current: string,
    operation: (workingDir: string) => Promise<RecipeSession>
  ) => Promise<{ workingDir: string; value: RecipeSession } | null>;
  recordSuccess?: (event: CapabilityUsageEvent) => Promise<boolean>;
}

export async function createRecipeSessionForWorkspace(
  recipeId: string,
  workspaceMode: 'code' | 'codepro',
  dependencies: RecipeSessionDependencies = {
    create: createSession,
    getExplicitDir: getInitialWorkingDir,
    chooseOrdinary: runWithOrdinaryWorkingDir,
    recordSuccess: recordCapabilitySuccess,
  }
): Promise<RecipeSession | null> {
  if (workspaceMode === 'codepro') {
    throw new Error('CodePro recipes require Project workspace confirmation');
  }
  const launch = await dependencies.chooseOrdinary(dependencies.getExplicitDir(), (workingDir) =>
    dependencies.create(workingDir, { recipeId, workspaceMode: 'code' })
  );
  const session = launch?.value ?? null;
  if (session && dependencies.recordSuccess) {
    await recordCommonTaskSessionStarted(recipeId, session.id, dependencies.recordSuccess);
  }
  return session;
}

export function getRecipeNewWindowOptions(
  recipeId: string,
  workspaceMode: 'code' | 'codepro',
  explicitWorkingDir: string
) {
  if (workspaceMode === 'codepro') {
    return {
      recipeId,
      viewType: 'codepro-pair',
      workspaceMode: 'codepro' as const,
    };
  }
  return {
    recipeId,
    viewType: 'pair',
    dir: explicitWorkingDir,
    workspaceMode: 'code' as const,
  };
}

export function routeCodeProRecipeToWorkspaceHub(
  recipeId: string,
  workspaceMode: 'code' | 'codepro',
  setView: ReturnType<typeof useNavigation>
): boolean {
  if (workspaceMode !== 'codepro') return false;
  setView('pair', { recipeId });
  return true;
}

export default function RecipesView() {
  const intl = useIntl();
  const setView = useNavigation();
  const location = useLocation();
  const workspaceMode = getRecipeWorkspaceMode(location.pathname);
  const [savedRecipes, setSavedRecipes] = useState<RecipeManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeManifest | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showContent, setShowContent] = useState(false);

  const [showCreateChoice, setShowCreateChoice] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [taskDescription, setTaskDescription] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [pendingRunRecipe, setPendingRunRecipe] = useState<RecipeManifest | null>(null);
  const [usageByRecipeId, setUsageByRecipeId] = useState<Map<string, CapabilityUsageRecord>>(
    new Map()
  );

  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleRecipeManifest, setScheduleRecipeManifest] = useState<RecipeManifest | null>(null);
  const [scheduleCron, setScheduleCron] = useState<string>('');

  const [showSlashCommandDialog, setShowSlashCommandDialog] = useState(false);
  const [slashCommandRecipeManifest, setSlashCommandRecipeManifest] =
    useState<RecipeManifest | null>(null);
  const [slashCommand, setSlashCommand] = useState<string>('');
  const [scheduleValid, setScheduleIsValid] = useState(true);

  const [searchTerm, setSearchTerm] = useState('');

  const filteredRecipes = useMemo(() => {
    if (!searchTerm) return savedRecipes;

    const searchLower = searchTerm.toLowerCase();
    return savedRecipes.filter((recipeManifest) => {
      const { recipe, slash_command } = recipeManifest;
      const title = recipe.title?.toLowerCase() || '';
      const description = recipe.description?.toLowerCase() || '';
      const slashCmd = slash_command?.toLowerCase() || '';

      return (
        title.includes(searchLower) ||
        description.includes(searchLower) ||
        slashCmd.includes(searchLower)
      );
    });
  }, [savedRecipes, searchTerm]);

  useEffect(() => {
    loadSavedRecipes();
  }, []);

  useEscapeKey(showEditor, () => setShowEditor(false));

  useEffect(() => {
    if (!loading && showSkeleton) {
      const timer = setTimeout(() => {
        setShowSkeleton(false);
        setTimeout(() => {
          setShowContent(true);
        }, 50);
      }, 300);

      return () => clearTimeout(timer);
    }
    return () => void 0;
  }, [loading, showSkeleton]);

  const loadSavedRecipes = async () => {
    try {
      setLoading(true);
      setShowSkeleton(true);
      setShowContent(false);
      setError(null);
      const [recipeManifestResponses, usage] = await Promise.all([
        listSavedRecipes(),
        listCapabilityUsage().catch(() => ({ records: [] as CapabilityUsageRecord[] })),
      ]);
      setSavedRecipes(recipeManifestResponses);
      setUsageByRecipeId(
        new Map(
          usage.records
            .filter((record) => record.kind === 'common_task')
            .map((record) => [record.capabilityId, record])
        )
      );
    } catch (err) {
      setError(errorMessage(err, 'Failed to load recipes'));
      console.error('Failed to load saved recipes:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDescribeTask = () => {
    const prompt = buildCommonTaskCreationPrompt(taskDescription);
    if (!prompt) return;
    setShowCreateChoice(false);
    setTaskDescription('');
    setView('pair', {
      initialMessage: { msg: prompt, images: [] },
      noAutoSubmit: true,
    });
  };

  const handleStartRecipeChat = async (recipeId: string) => {
    try {
      if (routeCodeProRecipeToWorkspaceHub(recipeId, workspaceMode, setView)) {
        trackRecipeStarted(true, undefined, false);
        return;
      }
      const session = await createRecipeSessionForWorkspace(recipeId, workspaceMode);
      if (!session) return;
      trackRecipeStarted(true, undefined, false);

      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED, { detail: { session } }));

      setView('pair', {
        disableAnimation: true,
        resumeSessionId: session.id,
        initialMessage: session.recipe?.prompt
          ? { msg: session.recipe.prompt, images: [] }
          : undefined,
      });
    } catch (error) {
      if (isRecipeParamsCancelled(error)) {
        setView('chat');
        return;
      }
      console.error('Failed to load recipe:', error);
      const errorMsg = errorMessage(error, 'Failed to load recipe');
      trackRecipeStarted(false, getErrorType(error), false);
      toastError({ title: intl.formatMessage(i18n.errorLoadingRecipes), msg: errorMsg });
    }
  };

  const handleStartRecipeChatInNewWindow = async (recipeId: string) => {
    try {
      window.electron.createChatWindow(
        getRecipeNewWindowOptions(recipeId, workspaceMode, getInitialWorkingDir())
      );
      trackRecipeStarted(true, undefined, true);
    } catch (error) {
      console.error('Failed to open recipe in new window:', error);
      trackRecipeStarted(false, getErrorType(error), true);
    }
  };

  const handleDeleteRecipe = async (recipeManifest: RecipeManifest) => {
    const result = await window.electron.showMessageBox({
      type: 'warning',
      buttons: [intl.formatMessage(i18n.cancel), 'Delete'],
      defaultId: 0,
      title: intl.formatMessage(i18n.deleteRecipeTitle),
      message: intl.formatMessage(i18n.deleteRecipeConfirm, { title: recipeManifest.recipe.title }),
      detail: intl.formatMessage(i18n.deleteRecipeDetail),
    });

    if (result.response !== 1) {
      return;
    }

    try {
      await deleteRecipe(recipeManifest.id);
      trackRecipeDeleted(true);
      await loadSavedRecipes();
      toastSuccess({
        title: recipeManifest.recipe.title,
        msg: intl.formatMessage(i18n.recipeDeletedSuccess),
      });
    } catch (err) {
      console.error('Failed to delete recipe:', err);
      const errorMsg = errorMessage(err, 'Failed to delete recipe');
      trackRecipeDeleted(false, getErrorType(err));
      setError(errorMsg);
    }
  };

  const handleEditRecipe = async (recipeManifest: RecipeManifest) => {
    setSelectedRecipe(recipeManifest);
    setShowEditor(true);
  };

  const handleEditorClose = (wasSaved?: boolean) => {
    setShowEditor(false);
    setSelectedRecipe(null);
    if (wasSaved) {
      loadSavedRecipes();
    }
  };

  const handleCopyDeeplink = async (recipeManifest: RecipeManifest) => {
    try {
      const deeplink = await generateDeepLink(recipeManifest.recipe);
      await navigator.clipboard.writeText(deeplink);
      trackRecipeDeeplinkCopied(true);
      toastSuccess({
        title: intl.formatMessage(i18n.deeplinkCopiedTitle),
        msg: intl.formatMessage(i18n.deeplinkCopiedMsg),
      });
    } catch (error) {
      console.error('Failed to copy deeplink:', error);
      trackRecipeDeeplinkCopied(false, getErrorType(error));
      toastError({
        title: intl.formatMessage(i18n.copyFailedTitle),
        msg: intl.formatMessage(i18n.copyDeeplinkFailedMsg),
      });
    }
  };

  const handleCopyYaml = async (recipeManifest: RecipeManifest) => {
    try {
      const yaml = await recipeToYaml(recipeManifest.recipe);

      if (!yaml) {
        throw new Error('No YAML data returned from API');
      }

      await navigator.clipboard.writeText(yaml);
      trackRecipeYamlCopied(true);
      toastSuccess({
        title: intl.formatMessage(i18n.yamlCopiedTitle),
        msg: intl.formatMessage(i18n.yamlCopiedMsg),
      });
    } catch (error) {
      console.error('Failed to copy YAML:', error);
      trackRecipeYamlCopied(false, getErrorType(error));
      toastError({
        title: intl.formatMessage(i18n.copyFailedTitle),
        msg: intl.formatMessage(i18n.copyYamlFailedMsg),
      });
    }
  };

  const handleExportFile = async (recipeManifest: RecipeManifest) => {
    try {
      const yaml = await recipeToYaml(recipeManifest.recipe);

      if (!yaml) {
        throw new Error('No YAML data returned from API');
      }

      const sanitizedTitle = (recipeManifest.recipe.title || 'recipe')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const filename = `${sanitizedTitle}.yaml`;

      const result = await window.electron.showSaveDialog({
        title: intl.formatMessage(i18n.exportRecipeDialogTitle),
        defaultPath: filename,
        filters: [
          { name: intl.formatMessage(i18n.yamlFiles), extensions: ['yaml', 'yml'] },
          { name: intl.formatMessage(i18n.allFiles), extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePath) {
        await window.electron.writeFile(result.filePath, yaml);
        trackRecipeExportedToFile(true);
        toastSuccess({
          title: intl.formatMessage(i18n.recipeExportedTitle),
          msg: intl.formatMessage(i18n.recipeExportedMsg, { filePath: result.filePath }),
        });
      }
    } catch (error) {
      console.error('Failed to export recipe:', error);
      trackRecipeExportedToFile(false, getErrorType(error));
      toastError({
        title: intl.formatMessage(i18n.exportFailedTitle),
        msg: intl.formatMessage(i18n.exportFailedMsg),
      });
    }
  };

  const handleOpenScheduleDialog = async (recipeManifest: RecipeManifest) => {
    if (!recipeManifest.schedule_cron) {
      try {
        const deeplink = await generateDeepLink(recipeManifest.recipe);
        setView('schedules', { pendingScheduleDeepLink: deeplink });
      } catch (error) {
        console.error('Failed to prepare automatic task:', error);
        toastError({
          title: intl.formatMessage(i18n.copyFailedTitle),
          msg: errorMessage(error, 'Failed to prepare automatic task'),
        });
      }
      return;
    }

    setScheduleRecipeManifest(recipeManifest);
    setScheduleCron(recipeManifest.schedule_cron || '0 0 14 * * *');
    setShowScheduleDialog(true);
  };

  const handleSaveSchedule = async () => {
    if (!scheduleRecipeManifest) return;

    const action = scheduleRecipeManifest.schedule_cron ? 'edit' : 'add';

    try {
      await scheduleRecipe(scheduleRecipeManifest.id, scheduleCron);

      trackRecipeScheduled(true, action);
      toastSuccess({
        title: intl.formatMessage(i18n.scheduleSavedTitle),
        msg: intl.formatMessage(i18n.scheduleSavedMsg, { schedule: getReadableCron(scheduleCron) }),
      });

      setShowScheduleDialog(false);
      setScheduleRecipeManifest(null);
      await loadSavedRecipes();
    } catch (error) {
      console.error('Failed to save schedule:', error);
      const errorMsg = errorMessage(error, 'Failed to save schedule');
      trackRecipeScheduled(false, action, getErrorType(error));
      setError(errorMsg);
    }
  };

  const handleRemoveSchedule = async () => {
    if (!scheduleRecipeManifest) return;

    try {
      await scheduleRecipe(scheduleRecipeManifest.id, null);

      trackRecipeScheduled(true, 'remove');
      toastSuccess({
        title: intl.formatMessage(i18n.scheduleRemovedTitle),
        msg: intl.formatMessage(i18n.scheduleRemovedMsg),
      });

      setShowScheduleDialog(false);
      setScheduleRecipeManifest(null);
      await loadSavedRecipes();
    } catch (error) {
      console.error('Failed to remove schedule:', error);
      const errorMsg = errorMessage(error, 'Failed to remove schedule');
      trackRecipeScheduled(false, 'remove', getErrorType(error));
      setError(errorMsg);
    }
  };

  const handleOpenSlashCommandDialog = (recipeManifest: RecipeManifest) => {
    setSlashCommandRecipeManifest(recipeManifest);
    setSlashCommand(recipeManifest.slash_command || '');
    setShowSlashCommandDialog(true);
  };

  const handleSaveSlashCommand = async () => {
    if (!slashCommandRecipeManifest) return;

    const action = slashCommand
      ? slashCommandRecipeManifest.slash_command
        ? 'edit'
        : 'add'
      : 'remove';

    try {
      await setRecipeSlashCommand(slashCommandRecipeManifest.id, slashCommand || null);

      trackRecipeSlashCommandSet(true, action);
      toastSuccess({
        title: intl.formatMessage(i18n.slashCommandSavedTitle),
        msg: slashCommand
          ? intl.formatMessage(i18n.slashCommandSavedMsg, { command: slashCommand })
          : intl.formatMessage(i18n.slashCommandRemovedMsg),
      });

      setShowSlashCommandDialog(false);
      setSlashCommandRecipeManifest(null);
      await loadSavedRecipes();
    } catch (error) {
      console.error('Failed to save slash command:', error);
      const errorMsg = errorMessage(error, 'Failed to save slash command');
      trackRecipeSlashCommandSet(false, action, getErrorType(error));
      setError(errorMsg);
    }
  };

  const handleRemoveSlashCommand = async () => {
    if (!slashCommandRecipeManifest) return;

    try {
      await setRecipeSlashCommand(slashCommandRecipeManifest.id, null);

      trackRecipeSlashCommandSet(true, 'remove');
      toastSuccess({
        title: intl.formatMessage(i18n.slashCommandRemovedTitle),
        msg: intl.formatMessage(i18n.slashCommandRemovedMsg),
      });

      setShowSlashCommandDialog(false);
      setSlashCommandRecipeManifest(null);
      await loadSavedRecipes();
    } catch (error) {
      console.error('Failed to remove slash command:', error);
      const errorMsg = errorMessage(error, 'Failed to remove slash command');
      trackRecipeSlashCommandSet(false, 'remove', getErrorType(error));
      setError(errorMsg);
    }
  };

  const getReadableCron = (cron: string): string => {
    try {
      const cronWithoutSeconds = cron.split(' ').slice(1).join(' ');
      return cronstrue.toString(cronWithoutSeconds).toLowerCase();
    } catch {
      return cron;
    }
  };

  const RecipeItem = ({
    recipeManifestResponse,
    recipeManifestResponse: { recipe, last_modified: lastModified, schedule_cron, slash_command },
  }: {
    recipeManifestResponse: RecipeManifest;
  }) => {
    const commonTask = buildCommonTaskModel(
      recipeManifestResponse,
      usageByRecipeId.get(recipeManifestResponse.id)
    );
    return (
      <Card className="py-2 px-4 mb-2 bg-background-primary border-none hover:bg-background-secondary transition-all duration-150">
        <div className="flex justify-between items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base truncate max-w-[50vw]">{recipe.title}</h3>
            </div>
            <p className="text-text-secondary text-sm mb-2 line-clamp-2">{recipe.description}</p>
            <div className="mb-2 flex flex-wrap gap-1 text-xs text-text-secondary">
              <span className="rounded bg-background-secondary px-2 py-1">
                {intl.formatMessage(i18n.modelLabel, {
                  model:
                    commonTask.model === 'Default model'
                      ? intl.formatMessage(i18n.defaultModel)
                      : commonTask.model,
                })}
              </span>
              {commonTask.extensions.length > 0 && (
                <span className="rounded bg-background-secondary px-2 py-1">
                  {intl.formatMessage(i18n.toolsLabel, {
                    tools: commonTask.extensions.join(', '),
                  })}
                </span>
              )}
              {commonTask.knownFiles.length > 0 && (
                <span className="rounded bg-background-secondary px-2 py-1">
                  {intl.formatMessage(i18n.filesLabel, {
                    files: commonTask.knownFiles.join(', '),
                  })}
                </span>
              )}
              {commonTask.riskSummary.map((risk) => (
                <span key={risk} className="rounded bg-amber-100 px-2 py-1 text-amber-900">
                  {risk === 'External tool access may require confirmation'
                    ? intl.formatMessage(i18n.externalToolRisk)
                    : risk}
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-1 text-xs text-text-secondary">
              <div className="flex items-center">
                <Calendar className="w-3 h-3 mr-1" />
                {convertToLocaleDateString(lastModified)}
              </div>
              <div className="flex items-center">
                <Clock className="w-3 h-3 mr-1" />
                {intl.formatMessage(i18n.lastRun, {
                  time: commonTask.lastRunAt
                    ? convertToLocaleDateString(commonTask.lastRunAt)
                    : intl.formatMessage(i18n.neverRun),
                })}
              </div>
              <div>
                {intl.formatMessage(i18n.recentResult, {
                  result:
                    commonTask.recentResult === 'session started'
                      ? intl.formatMessage(i18n.sessionStarted)
                      : (commonTask.recentResult ?? intl.formatMessage(i18n.noRecentResult)),
                })}
              </div>
              {(schedule_cron || slash_command) && (
                <div className="flex items-center gap-3">
                  {schedule_cron && (
                    <div className="flex items-center text-blue-600 dark:text-blue-400">
                      <Clock className="w-3 h-3 mr-1" />
                      {intl.formatMessage(i18n.runs, { schedule: getReadableCron(schedule_cron) })}
                    </div>
                  )}
                  {slash_command && (
                    <div className="flex items-center text-purple-600 dark:text-purple-400">
                      /{slash_command}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <Button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenSlashCommandDialog(recipeManifestResponse);
            }}
            variant={slash_command ? 'default' : 'outline'}
            size="sm"
            className="h-8 w-8 p-0"
            title={
              slash_command
                ? intl.formatMessage(i18n.editSlashCommand)
                : intl.formatMessage(i18n.addSlashCommand)
            }
          >
            <Terminal className="w-4 h-4" />
          </Button>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              onClick={async (e) => {
                e.stopPropagation();
                setPendingRunRecipe(recipeManifestResponse);
              }}
              size="sm"
              className="h-8 px-3"
              title={intl.formatMessage(i18n.useRecipe)}
            >
              <Play className="mr-1 w-4 h-4" />
              {intl.formatMessage(i18n.useRecipe)}
            </Button>
            <Button
              onClick={async (e) => {
                e.stopPropagation();
                await handleStartRecipeChatInNewWindow(recipeManifestResponse.id);
              }}
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              title={intl.formatMessage(i18n.openInNewWindow)}
            >
              <ExternalLink className="w-4 h-4" />
            </Button>
            <Button
              onClick={async (e) => {
                e.stopPropagation();
                await handleEditRecipe(recipeManifestResponse);
              }}
              variant="outline"
              size="sm"
              className="h-8 px-3"
              title={intl.formatMessage(i18n.editRecipe)}
            >
              <Edit className="mr-1 w-4 h-4" />
              {intl.formatMessage(i18n.editRecipe)}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  onClick={(e) => e.stopPropagation()}
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  title={intl.formatMessage(i18n.shareRecipe)}
                >
                  <Share2 className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => handleCopyDeeplink(recipeManifestResponse)}>
                  <Link className="w-4 h-4" />
                  {intl.formatMessage(i18n.copyDeeplink)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleCopyYaml(recipeManifestResponse)}>
                  <Copy className="w-4 h-4" />
                  {intl.formatMessage(i18n.copyYaml)}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleExportFile(recipeManifestResponse)}>
                  <Download className="w-4 h-4" />
                  {intl.formatMessage(i18n.exportToFile)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                void handleOpenScheduleDialog(recipeManifestResponse);
              }}
              variant={schedule_cron ? 'default' : 'outline'}
              size="sm"
              className="h-8 px-3"
              title={
                schedule_cron
                  ? intl.formatMessage(i18n.editSchedule)
                  : intl.formatMessage(i18n.addSchedule)
              }
            >
              <Clock className="mr-1 w-4 h-4" />
              {schedule_cron
                ? intl.formatMessage(i18n.editSchedule)
                : intl.formatMessage(i18n.addSchedule)}
            </Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteRecipe(recipeManifestResponse);
              }}
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              title={intl.formatMessage(i18n.deleteRecipe)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  const RecipeSkeleton = () => (
    <Card className="p-2 mb-2 bg-background-primary">
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-5 w-3/4 mb-2" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
        </div>
      </div>
    </Card>
  );

  const renderContent = () => {
    if (loading || showSkeleton) {
      return (
        <div className="space-y-6">
          <div className="space-y-3">
            <Skeleton className="h-6 w-24" />
            <div className="space-y-2">
              <RecipeSkeleton />
              <RecipeSkeleton />
              <RecipeSkeleton />
            </div>
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-text-secondary">
          <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
          <p className="text-lg mb-2">{intl.formatMessage(i18n.errorLoadingRecipes)}</p>
          <p className="text-sm text-center mb-4">{error}</p>
          <Button onClick={loadSavedRecipes} variant="default">
            {intl.formatMessage(i18n.tryAgain)}
          </Button>
        </div>
      );
    }

    if (savedRecipes.length === 0) {
      return (
        <div className="flex flex-col justify-center pt-2 h-full">
          <p className="text-lg">{intl.formatMessage(i18n.noSavedRecipes)}</p>
          <p className="text-sm text-text-secondary">
            {intl.formatMessage(i18n.noSavedRecipesDescription)}
          </p>
        </div>
      );
    }

    if (filteredRecipes.length === 0 && searchTerm) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-text-secondary mt-4">
          <FileText className="h-12 w-12 mb-4" />
          <p className="text-lg mb-2">{intl.formatMessage(i18n.noMatchingRecipes)}</p>
          <p className="text-sm">{intl.formatMessage(i18n.adjustSearchTerms)}</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {filteredRecipes.map((recipeManifestResponse: RecipeManifest) => (
          <RecipeItem
            key={recipeManifestResponse.id}
            recipeManifestResponse={recipeManifestResponse}
          />
        ))}
      </div>
    );
  };

  const pendingRunTask = pendingRunRecipe
    ? buildCommonTaskModel(pendingRunRecipe, usageByRecipeId.get(pendingRunRecipe.id))
    : null;

  return (
    <>
      <MainPanelLayout>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="bg-background-primary px-4 pb-6 pt-8 sm:px-8 sm:pb-8 sm:pt-16">
            <div className="flex flex-col page-transition">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                <h1 className="whitespace-nowrap text-3xl font-light sm:text-4xl">
                  {intl.formatMessage(i18n.recipesTitle)}
                </h1>
                <div className="flex flex-wrap items-stretch gap-2">
                  <Button
                    onClick={() => setShowCreateChoice(true)}
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-2"
                  >
                    <FileText className="w-4 h-4" />
                    {intl.formatMessage(i18n.createRecipe)}
                  </Button>
                  <ImportRecipeButton onClick={() => setShowImportDialog(true)} />
                </div>
              </div>
              <p className="break-words text-sm text-text-secondary mb-1">
                {intl.formatMessage(i18n.recipesDescription, { shortcut: getSearchShortcutText() })}
              </p>
            </div>
          </div>

          <div className="flex-1 min-h-0 relative px-4 sm:px-8">
            <ScrollArea className="h-full">
              <SearchView
                onSearch={(term) => setSearchTerm(term)}
                placeholder={intl.formatMessage(i18n.searchRecipesPlaceholder)}
              >
                <div
                  className={`h-full relative transition-all duration-300 ${
                    showContent ? 'opacity-100 animate-in fade-in ' : 'opacity-0'
                  }`}
                >
                  {renderContent()}
                </div>
              </SearchView>
            </ScrollArea>
          </div>
        </div>
      </MainPanelLayout>

      <CommonTaskCreationDialog
        open={showCreateChoice}
        description={taskDescription}
        labels={{
          title: intl.formatMessage(i18n.createRecipe),
          descriptionTitle: intl.formatMessage(i18n.describeTask),
          descriptionHelp: intl.formatMessage(i18n.describeTaskHelp),
          descriptionPlaceholder: intl.formatMessage(i18n.describeTaskPlaceholder),
          cancel: intl.formatMessage(i18n.cancel),
          manualSetup: intl.formatMessage(i18n.manualSetup),
          continueInNewTask: intl.formatMessage(i18n.continueInNewTask),
        }}
        onOpenChange={(open) => {
          setShowCreateChoice(open);
          if (!open) setTaskDescription('');
        }}
        onDescriptionChange={setTaskDescription}
        onDescribe={handleDescribeTask}
        onManualSetup={() => {
          setShowCreateChoice(false);
          setTaskDescription('');
          setShowCreateDialog(true);
        }}
      />

      <CommonTaskRunSummaryDialog
        task={pendingRunTask}
        labels={{
          title: intl.formatMessage(i18n.runSummaryTitle),
          help: intl.formatMessage(i18n.runSummaryHelp),
          model: (model) =>
            intl.formatMessage(i18n.modelLabel, {
              model: model === 'Default model' ? intl.formatMessage(i18n.defaultModel) : model,
            }),
          tools: (tools) => intl.formatMessage(i18n.toolsLabel, { tools: tools.join(', ') }),
          files: (files) => intl.formatMessage(i18n.filesLabel, { files: files.join(', ') }),
          noDeclaredTools: intl.formatMessage(i18n.noDeclaredTools),
          noKnownFiles: intl.formatMessage(i18n.noKnownFiles),
          externalToolRisk: intl.formatMessage(i18n.externalToolRisk),
          cancel: intl.formatMessage(i18n.cancel),
          run: intl.formatMessage(i18n.useRecipe),
        }}
        onClose={() => setPendingRunRecipe(null)}
        onRun={(recipeId) => {
          setPendingRunRecipe(null);
          void handleStartRecipeChat(recipeId);
        }}
      />

      {showEditor && selectedRecipe && (
        <CreateEditRecipeModal
          isOpen={showEditor}
          onClose={handleEditorClose}
          recipe={selectedRecipe.recipe}
          recipeId={selectedRecipe.id}
        />
      )}

      <ImportRecipeForm
        isOpen={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onSuccess={loadSavedRecipes}
      />

      {showCreateDialog && (
        <CreateEditRecipeModal
          isOpen={showCreateDialog}
          onClose={() => {
            setShowCreateDialog(false);
            loadSavedRecipes();
          }}
          isCreateMode={true}
        />
      )}

      {showScheduleDialog && scheduleRecipeManifest && (
        <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {intl.formatMessage(i18n.scheduleDialogTitle, {
                  action: scheduleRecipeManifest.schedule_cron ? 'Edit' : 'Add',
                })}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <CronPicker
                schedule={
                  scheduleRecipeManifest.schedule_cron
                    ? {
                        id: scheduleRecipeManifest.id,
                        source: '',
                        cron: scheduleRecipeManifest.schedule_cron,
                        lastRun: null,
                        currentlyRunning: false,
                        paused: false,
                        tested: true,
                        workspaceMode,
                      }
                    : null
                }
                onChange={setScheduleCron}
                isValid={setScheduleIsValid}
              />
              <div className="flex gap-2 justify-end">
                {scheduleRecipeManifest.schedule_cron && (
                  <Button variant="outline" onClick={handleRemoveSchedule}>
                    {intl.formatMessage(i18n.removeSchedule)}
                  </Button>
                )}
                <Button variant="outline" onClick={() => setShowScheduleDialog(false)}>
                  {intl.formatMessage(i18n.cancel)}
                </Button>
                <Button onClick={handleSaveSchedule} disabled={!scheduleValid}>
                  {intl.formatMessage(i18n.save)}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {showSlashCommandDialog && slashCommandRecipeManifest && (
        <Dialog open={showSlashCommandDialog} onOpenChange={setShowSlashCommandDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{intl.formatMessage(i18n.slashCommandTitle)}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground mb-3">
                  {intl.formatMessage(i18n.slashCommandDescription)}
                </p>
                <div className="flex gap-2 items-center">
                  <span className="text-muted-foreground">/</span>
                  <input
                    type="text"
                    value={slashCommand}
                    onChange={(e) => setSlashCommand(e.target.value)}
                    placeholder={intl.formatMessage(i18n.slashCommandPlaceholder)}
                    className="flex-1 px-3 py-2 border rounded text-sm"
                  />
                </div>
                {slashCommand && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {intl.formatMessage(i18n.slashCommandUsageHint, { command: slashCommand })}
                  </p>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                {slashCommandRecipeManifest.slash_command && (
                  <Button variant="outline" onClick={handleRemoveSlashCommand}>
                    {intl.formatMessage(i18n.remove)}
                  </Button>
                )}
                <Button variant="outline" onClick={() => setShowSlashCommandDialog(false)}>
                  {intl.formatMessage(i18n.cancel)}
                </Button>
                <Button onClick={handleSaveSlashCommand}>{intl.formatMessage(i18n.save)}</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
